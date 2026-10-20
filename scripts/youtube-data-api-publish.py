#!/usr/bin/env python3
"""Publish an uploaded private video (public or scheduled) and post its comment.

Called only by `goldflow youtube publish`, the human publish approval. The
YouTube Data API has no endpoint to pin a comment, so pinning stays a Studio
follow-up. Prints one JSON line with the verified result. Never prints tokens.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DEFAULT_CLIENT_SECRET = Path(
    "/Users/joel/youtube-niche-research/manhwa-webtoon-recap/config/"
    "youtube_analytics_client_secret.json"
)
# Separate token: managing visibility and comments needs youtube.force-ssl.
DEFAULT_TOKEN = Path(
    "/Users/joel/youtube-niche-research/manhwa-webtoon-recap/config/"
    "youtube_publish_manage_token.json"
)
SCOPES = ("https://www.googleapis.com/auth/youtube.force-ssl",)


def credentials(client_secret: Path, token: Path, port: int):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None
    if token.is_file():
        creds = Credentials.from_authorized_user_file(str(token), list(SCOPES))
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    if not creds or not creds.valid:
        if not client_secret.is_file():
            raise SystemExit(f"Missing OAuth client secret: {client_secret}")
        flow = InstalledAppFlow.from_client_secrets_file(str(client_secret), list(SCOPES))
        creds = flow.run_local_server(port=port, open_browser=True, prompt="consent select_account")
        token.parent.mkdir(parents=True, exist_ok=True)
        token.write_text(creds.to_json() + "\n", encoding="utf-8")
    return creds


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video-id")
    parser.add_argument("--visibility", choices=("public", "scheduled"))
    parser.add_argument("--publish-at")
    parser.add_argument("--comment-text")
    parser.add_argument("--authorize-only", action="store_true", help="Run the one-time youtube.force-ssl consent, write the token and exit without touching any video.")
    parser.add_argument("--client-secret", type=Path, default=DEFAULT_CLIENT_SECRET)
    parser.add_argument("--token", type=Path, default=DEFAULT_TOKEN)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    if args.authorize_only:
        credentials(args.client_secret, args.token, args.port)
        print(json.dumps({"status": "authorized", "token_path": str(args.token), "scopes": list(SCOPES)}))
        return
    for required in ("video_id", "visibility", "comment_text"):
        if not getattr(args, required):
            raise SystemExit(f"--{required.replace('_', '-')} is required unless --authorize-only is given.")
    if args.visibility == "scheduled" and not args.publish_at:
        raise SystemExit("--publish-at is required for scheduled visibility.")

    from googleapiclient.discovery import build

    youtube = build("youtube", "v3", credentials=credentials(args.client_secret, args.token, args.port), cache_discovery=False)
    current = youtube.videos().list(part="status", id=args.video_id).execute()
    items = current.get("items") or []
    if len(items) != 1:
        raise SystemExit(f"Video {args.video_id} not found on the authenticated channel.")
    status = dict(items[0]["status"])
    if args.visibility == "public":
        status["privacyStatus"] = "public"
        status.pop("publishAt", None)
    else:
        status["privacyStatus"] = "private"
        status["publishAt"] = args.publish_at
    updated = youtube.videos().update(part="status", body={"id": args.video_id, "status": status}).execute()

    thread = youtube.commentThreads().insert(
        part="snippet",
        body={"snippet": {"videoId": args.video_id, "topLevelComment": {"snippet": {"textOriginal": args.comment_text}}}},
    ).execute()
    comment = thread.get("snippet", {}).get("topLevelComment", {})
    print(json.dumps({
        "video_id": args.video_id,
        "privacy_status": updated.get("status", {}).get("privacyStatus"),
        "publish_at": updated.get("status", {}).get("publishAt"),
        "comment_id": comment.get("id"),
        "comment_url": f"https://www.youtube.com/watch?v={args.video_id}&lc={comment.get('id')}" if comment.get("id") else None,
        "comment_text": comment.get("snippet", {}).get("textOriginal"),
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Publish interrupted.", file=sys.stderr)
        raise SystemExit(130)
