#!/usr/bin/env python3
"""Write the deployed revision and its three most recent commits as JSON."""

import argparse
import json
import os
from pathlib import Path
import subprocess


def git(repository, *args):
    return subprocess.run(
        ["git", "-C", repository, *args],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    ).stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--branch", default="main")
    parser.add_argument(
        "--repository-url",
        default="https://github.com/42tr/3dbox4agent",
    )
    args = parser.parse_args()

    revisions = git(args.repository, "rev-list", "-3", args.commit).splitlines()
    commits = []
    for revision in revisions:
        fields = git(
            args.repository,
            "show",
            "-s",
            "--format=%H%x00%h%x00%an%x00%aI%x00%B",
            revision,
        ).split("\x00")
        if len(fields) != 5:
            raise RuntimeError(f"Unexpected git show output for {revision}")
        full_sha, short_sha, author, authored_at, message = fields
        message = message.strip()
        lines = message.splitlines()
        commits.append({
            "sha": full_sha,
            "shortSha": short_sha,
            "author": author,
            "authoredAt": authored_at,
            "subject": lines[0] if lines else "",
            "body": "\n".join(lines[1:]).strip(),
        })

    document = {
        "repository": args.repository_url.rstrip("/"),
        "branch": args.branch,
        "commit": args.commit,
        "commits": commits,
    }
    output = Path(args.output)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, output)


if __name__ == "__main__":
    main()
