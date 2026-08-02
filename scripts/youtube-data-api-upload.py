#!/usr/bin/env python3
"""Upload a passed Goldflow YouTube manifest through the YouTube Data API."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


DEFAULT_CLIENT_SECRET = Path(
    "/Users/joel/youtube-niche-research/manhwa-webtoon-recap/config/"
    "youtube_analytics_client_secret.json"
)
DEFAULT_TOKEN = Path(
    "/Users/joel/youtube-niche-research/manhwa-webtoon-recap/config/"
    "youtube_publish_token.json"
)
SCOPES = (
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
)
MANIFEST_SCHEMA = "goldflow_youtube_publish_manifest_v1"


def require_google_libraries() -> dict[str, Any]:
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaFileUpload
    except ImportError as exc:
        raise SystemExit(
            "Missing Google API dependencies. Use the research environment:\n"
            "  /Users/joel/youtube-niche-research/manhwa-webtoon-recap/.venv/bin/python"
        ) from exc
    return {
        "Request": Request,
        "Credentials": Credentials,
        "InstalledAppFlow": InstalledAppFlow,
        "build": build,
        "HttpError": HttpError,
        "MediaFileUpload": MediaFileUpload,
    }


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Missing or invalid JSON: {path}") from exc
    if not isinstance(value, dict):
        raise SystemExit(f"Expected a JSON object: {path}")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> dict[str, Any]:
    manifest = read_json(path)
    if manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("status") != "passed":
        raise SystemExit(f"Passed Goldflow YouTube manifest required: {path}")
    for key in ("video", "thumbnail", "title", "description", "youtube_channel", "publish_settings"):
        if not manifest.get(key):
            raise SystemExit(f"Manifest is missing required field: {key}")
    for media_key in ("video", "thumbnail"):
        media_path = Path(str(manifest[media_key].get("path", ""))).expanduser().resolve()
        if not media_path.is_file():
            raise SystemExit(f"Manifest {media_key} file is missing: {media_path}")
        expected_hash = str(manifest[media_key].get("sha256", "")).strip()
        actual_hash = sha256_file(media_path)
        if actual_hash != expected_hash:
            raise SystemExit(
                f"Manifest {media_key} hash mismatch: expected {expected_hash}, got {actual_hash}"
            )
    if manifest["publish_settings"].get("initial_visibility") != "private":
        raise SystemExit("API upload recovery requires initial_visibility=private.")
    return manifest


def credentials(
    *,
    client_secret: Path,
    token: Path,
    force_reauth: bool,
    port: int,
) -> Any:
    libs = require_google_libraries()
    creds = None
    if token.is_file() and not force_reauth:
        creds = libs["Credentials"].from_authorized_user_file(str(token), list(SCOPES))
        if not set(SCOPES).issubset(set(creds.scopes or [])):
            creds = None
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(libs["Request"]())
    if not creds or not creds.valid:
        if not client_secret.is_file():
            raise SystemExit(f"Missing OAuth client secret: {client_secret}")
        flow = libs["InstalledAppFlow"].from_client_secrets_file(
            str(client_secret),
            list(SCOPES),
        )
        creds = flow.run_local_server(
            port=port,
            open_browser=True,
            prompt="consent select_account",
        )
        token.parent.mkdir(parents=True, exist_ok=True)
        token.write_text(creds.to_json() + "\n", encoding="utf-8")
    return creds


def channel_identity(youtube: Any) -> dict[str, str]:
    response = youtube.channels().list(part="snippet", mine=True).execute()
    items = response.get("items") or []
    if len(items) != 1:
        raise SystemExit(f"Expected one authenticated YouTube channel, found {len(items)}.")
    snippet = items[0].get("snippet") or {}
    return {
        "id": str(items[0].get("id", "")),
        "name": str(snippet.get("title", "")),
        "handle": str(snippet.get("customUrl", "")),
    }


def normalized_handle(value: str) -> str:
    return value.strip().lower().lstrip("@")


def verify_channel(manifest: dict[str, Any], actual: dict[str, str]) -> None:
    expected = manifest["youtube_channel"]
    name_matches = actual["name"].strip().casefold() == str(expected.get("expected_name", "")).strip().casefold()
    handle_matches = normalized_handle(actual["handle"]) == normalized_handle(
        str(expected.get("expected_handle", ""))
    )
    if not name_matches and not handle_matches:
        raise SystemExit(
            "Authenticated channel does not match manifest: "
            f"expected {expected}, got {actual}."
        )


def resumable_upload(request: Any, http_error: type[Exception]) -> dict[str, Any]:
    response = None
    while response is None:
        try:
            status, response = request.next_chunk()
        except http_error as exc:
            raise SystemExit(f"YouTube video upload failed: {exc}") from exc
        if status is not None:
            print(
                json.dumps(
                    {
                        "event": "video_upload_progress",
                        "progress_pct": round(float(status.progress()) * 100, 2),
                    }
                ),
                flush=True,
            )
    return response


def upload(args: argparse.Namespace) -> None:
    libs = require_google_libraries()
    manifest = load_manifest(args.manifest.resolve())
    creds = credentials(
        client_secret=args.client_secret.resolve(),
        token=args.token.resolve(),
        force_reauth=args.force_reauth,
        port=args.port,
    )
    youtube = libs["build"]("youtube", "v3", credentials=creds, cache_discovery=False)
    actual_channel = channel_identity(youtube)
    verify_channel(manifest, actual_channel)

    settings = manifest["publish_settings"]
    body = {
        "snippet": {
            "title": str(manifest["title"]),
            "description": str(manifest["description"]),
            "tags": [str(tag) for tag in manifest.get("tags") or []],
            "categoryId": str(args.category_id),
            "defaultLanguage": "en",
        },
        "status": {
            "privacyStatus": "private",
            "license": "youtube",
            "embeddable": True,
            "publicStatsViewable": True,
            "selfDeclaredMadeForKids": bool(settings.get("made_for_kids")),
            "containsSyntheticMedia": bool(settings.get("altered_content")),
        },
    }
    video_path = Path(manifest["video"]["path"]).resolve()
    media = libs["MediaFileUpload"](
        str(video_path),
        mimetype="video/mp4",
        chunksize=args.chunk_size_mb * 1024 * 1024,
        resumable=True,
    )
    request = youtube.videos().insert(
        part="snippet,status",
        body=body,
        media_body=media,
        notifySubscribers=False,
    )
    uploaded = resumable_upload(request, libs["HttpError"])
    video_id = str(uploaded.get("id", ""))
    if not video_id:
        raise SystemExit(f"YouTube returned no video id: {uploaded}")

    thumbnail_path = Path(manifest["thumbnail"]["path"]).resolve()
    thumbnail_media = libs["MediaFileUpload"](
        str(thumbnail_path),
        mimetype="image/jpeg",
        resumable=False,
    )
    try:
        youtube.thumbnails().set(
            videoId=video_id,
            media_body=thumbnail_media,
        ).execute()
    except libs["HttpError"] as exc:
        raise SystemExit(
            f"Video {video_id} uploaded privately, but thumbnail upload failed: {exc}"
        ) from exc

    verification = youtube.videos().list(
        part="snippet,status,processingDetails",
        id=video_id,
    ).execute()
    item = (verification.get("items") or [{}])[0]
    result = {
        "status": "uploaded_private",
        "channel": actual_channel,
        "video_id": video_id,
        "watch_url": f"https://www.youtube.com/watch?v={video_id}",
        "studio_url": f"https://studio.youtube.com/video/{video_id}/edit",
        "title": item.get("snippet", {}).get("title"),
        "privacy_status": item.get("status", {}).get("privacyStatus"),
        "self_declared_made_for_kids": item.get("status", {}).get("selfDeclaredMadeForKids"),
        "contains_synthetic_media": item.get("status", {}).get("containsSyntheticMedia"),
        "processing_status": item.get("processingDetails", {}).get("processingStatus"),
        "thumbnail_uploaded": True,
        "manifest_path": str(args.manifest.resolve()),
        "manifest_sha256": sha256_file(args.manifest.resolve()),
    }
    print(json.dumps(result, indent=2, ensure_ascii=False), flush=True)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--manifest", type=Path, required=True)
    value.add_argument("--client-secret", type=Path, default=DEFAULT_CLIENT_SECRET)
    value.add_argument("--token", type=Path, default=DEFAULT_TOKEN)
    value.add_argument("--force-reauth", action="store_true")
    value.add_argument("--port", type=int, default=8765)
    value.add_argument("--category-id", default="24")
    value.add_argument("--chunk-size-mb", type=int, default=16)
    return value


def main() -> None:
    args = parser().parse_args()
    if args.chunk_size_mb <= 0:
        raise SystemExit("--chunk-size-mb must be positive.")
    upload(args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Upload interrupted.", file=sys.stderr)
        raise SystemExit(130)
