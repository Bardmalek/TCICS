#!/usr/bin/env python3
"""
Send personalized TCICS / Tirgan Festival outreach emails from businesses.csv.

Usage:
  python sendmarketing.py --dry-run
  python sendmarketing.py --test admin@example.com
  python sendmarketing.py --test admin@example.com reviewer@example.com
  python sendmarketing.py --send-examples
  python sendmarketing.py

Required CSV columns:
  business_name, contact_name, email, website, category, city
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode


MAILGUN_API_KEY = os.getenv("MAILGUN_API_KEY", "")
MAILGUN_DOMAIN = os.getenv("MAILGUN_DOMAIN", "mg.tcics.com")
MAILGUN_SENDER = os.getenv(
    "MAILGUN_SENDER",
    "Bardia Malackzadeh <sponsor@tcics.com>",
)

DEFAULT_CSV = "businesses.csv"
DEFAULT_SKIP = "skip.txt"
DEFAULT_LOG = "sent.log"
DEFAULT_SUBJECT = "Tirgan Festival 2026 vendor and sponsorship opportunities"
DEFAULT_EXAMPLE_EMAILS = ["reviewer@example.com", "admin@example.com"]
SEND_DELAY_SECONDS = 2

EMAIL_RE = re.compile(r"^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$", re.IGNORECASE)


@dataclass
class Business:
    business_name: str
    contact_name: str
    email: str
    website: str
    category: str
    city: str


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def is_valid_email(email: str) -> bool:
    return bool(EMAIL_RE.match(normalize_email(email)))


def clean(value: str | None, fallback: str = "") -> str:
    value = (value or "").strip()
    return value if value else fallback


def read_skip_list(path: Path) -> set[str]:
    if not path.exists():
        return set()
    skipped: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        skipped.add(normalize_email(line))
    return skipped


def read_sent_log(path: Path) -> set[str]:
    if not path.exists():
        return set()
    sent: set[str] = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        # Format written by this script:
        # timestamp<TAB>email<TAB>STATUS<TAB>message
        parts = line.split("\t")
        if len(parts) >= 3 and parts[2] == "SUCCESS" and is_valid_email(parts[1]):
            sent.add(normalize_email(parts[1]))
    return sent


def log_result(path: Path, email: str, status: str, message: str) -> None:
    safe_message = " ".join(str(message).replace("\t", " ").split())
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"{now_iso()}\t{normalize_email(email)}\t{status}\t{safe_message}\n")


def read_businesses(path: Path) -> list[Business]:
    if not path.exists():
        raise FileNotFoundError(f"Could not find CSV file: {path}")

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"business_name", "contact_name", "email", "website", "category", "city"}
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(sorted(missing))}")

        businesses: list[Business] = []
        for row in reader:
            businesses.append(
                Business(
                    business_name=clean(row.get("business_name")),
                    contact_name=clean(row.get("contact_name")),
                    email=normalize_email(row.get("email", "")),
                    website=clean(row.get("website")),
                    category=clean(row.get("category")),
                    city=clean(row.get("city")),
                )
            )
        return businesses


def website_line(website: str) -> str:
    if not website:
        return ""
    parsed = urlparse(website if "://" in website else f"https://{website}")
    if not parsed.netloc:
        return ""
    display = parsed.netloc.removeprefix("www.")
    href = parsed.geturl()
    return f"\nI also had a chance to note your website ({display}), which gives a helpful sense of your brand and customer experience.\n"


def category_line(category: str) -> str:
    if not category:
        return "your business"
    return f"your work in the {category} space"


def city_line(city: str) -> str:
    if not city:
        return "the local community"
    return f"the {city} community"


def build_email_text(business: Business) -> str:
    contact_name = clean(business.contact_name, "there")
    business_name = clean(business.business_name, "your business")
    category = clean(business.category, "local business")

    return f"""Hello {contact_name},

I hope you're doing well.

I'm reaching out from TCICS, the Tri-City Iranian Cultural Society, about potential vendor, sponsorship, and community engagement opportunities around Tirgan Festival 2026.

We came across {business_name} and thought {category_line(category)} could be a strong fit for an event that brings together families, community members, and culturally connected audiences from across Metro Vancouver.
{website_line(business.website)}
Tirgan is one of TCICS's major cultural festivals, and our goal is to create a welcoming space where local businesses can connect directly with the community, build visibility, and participate in a meaningful cultural celebration.

Depending on your goals, there may be several ways to get involved:

- Vendor booth participation at Tirgan Festival 2026
- Sponsorship opportunities with community-facing visibility
- Persian-language or culturally targeted promotions
- Giveaways, community discounts, or featured business content
- Social media promotion through TCICS channels during the event period

To get a better sense of the atmosphere and scale of our previous programs, you can view highlights from past TCICS events here:
https://tcics.com/past-events/

You can also find more information about Tirgan Festival here:
https://tcics.com/events/tirgan-festival/

For booth rentals, vendor applications, and sponsorship opportunities, please visit:
https://tcics.com/up-coming-events/

Online booth booking:
https://www.tcicsbooking.com

If this sounds relevant for {business_name}, I would be happy to continue the conversation and explore what kind of participation would make the most sense for your team.

Warm regards,

Bardia Malekzadeh
Marketing Director
TCICS - Tri-City Iranian Cultural Society
sponsor@tcics.com

---
You received this email because we believe {business_name} may be interested in
participating in Tirgan Festival 2026. If you'd prefer not to hear from us,
reply with "unsubscribe" and we'll remove you immediately.

TCICS · Unit 241-3020 Lincoln Ave., Coquitlam BC V3B 6B4 · sponsor@tcics.com
"""


def build_email_html(business: Business) -> str:
    # Mailgun receives both text and HTML. Keep HTML simple for deliverability.
    text = build_email_text(business)
    paragraphs = []
    for block in text.split("\n\n"):
        escaped = (
            block.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )
        escaped = re.sub(r"(https?://[^\s<]+)", r'<a href="\1">\1</a>', escaped)
        escaped = escaped.replace("\n", "<br>")
        paragraphs.append(f"<p>{escaped}</p>")

    return f"""<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f5f2ed;color:#1a1916;font-family:Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:28px 20px;background:#fefcfa;">
    <div style="font-size:13px;line-height:1.65;color:#1a1916;">
      {''.join(paragraphs)}
    </div>
  </div>
</body>
</html>"""


def mailgun_send(to_email: str, subject: str, text: str, html: str) -> tuple[bool, str]:
    if not MAILGUN_API_KEY:
        return False, "MAILGUN_API_KEY must be set before sending"
    api_url = f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages"
    payload = urlencode(
        {
            "from": MAILGUN_SENDER,
            "to": to_email,
            "h:Reply-To": "sponsor@tcics.com",
            "subject": subject,
            "text": text,
            "html": html,
        }
    ).encode("utf-8")

    auth = ("api:" + MAILGUN_API_KEY).encode("utf-8")
    import base64

    request = Request(api_url, data=payload, method="POST")
    request.add_header("Authorization", "Basic " + base64.b64encode(auth).decode("ascii"))
    request.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8", errors="replace")
            if 200 <= response.status < 300:
                return True, body
            return False, f"HTTP {response.status}: {body}"
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return False, f"HTTP {error.code}: {body}"
    except URLError as error:
        return False, f"Network error: {error.reason}"
    except TimeoutError:
        return False, "Network timeout"


def fake_business_for_test(email: str, contact_name: str = "Bardia") -> Business:
    return Business(
        business_name="Fresh Nail Bar",
        contact_name=contact_name,
        email=normalize_email(email),
        website="https://www.tcics.com",
        category="beauty and wellness",
        city="Metro Vancouver",
    )


def example_businesses(emails: Iterable[str] = DEFAULT_EXAMPLE_EMAILS) -> list[Business]:
    examples: list[Business] = []
    for email in emails:
        clean_email = normalize_email(email)
        name = "Behzad" if clean_email.startswith("behzad") else "Bardia"
        examples.append(fake_business_for_test(clean_email, name))
    return examples


def eligible_rows(
    businesses: Iterable[Business],
    skip_emails: set[str],
    already_sent: set[str],
    log_path: Path,
) -> list[Business]:
    eligible: list[Business] = []
    seen_this_run: set[str] = set()

    for business in businesses:
        email = normalize_email(business.email)

        if not email or not is_valid_email(email):
            log_result(log_path, email or "(missing)", "SKIPPED", "Missing or invalid email")
            continue
        if email in skip_emails:
            log_result(log_path, email, "SKIPPED", "Email found in skip.txt")
            continue
        if email in already_sent:
            log_result(log_path, email, "SKIPPED", "Already successfully emailed in sent.log")
            continue
        if email in seen_this_run:
            log_result(log_path, email, "SKIPPED", "Duplicate email in this CSV")
            continue

        seen_this_run.add(email)
        eligible.append(business)

    return eligible


def print_preview(business: Business, subject: str) -> None:
    print("=" * 80)
    print(f"TO: {business.email}")
    print(f"SUBJECT: {subject}")
    print("-" * 80)
    print(build_email_text(business))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send TCICS marketing emails with Mailgun.")
    parser.add_argument("--csv", default=DEFAULT_CSV, help=f"CSV path, default: {DEFAULT_CSV}")
    parser.add_argument("--skip", default=DEFAULT_SKIP, help=f"Skip-list path, default: {DEFAULT_SKIP}")
    parser.add_argument("--log", default=DEFAULT_LOG, help=f"Send log path, default: {DEFAULT_LOG}")
    parser.add_argument("--subject", default=DEFAULT_SUBJECT, help="Email subject line")
    parser.add_argument("--dry-run", action="store_true", help="Print emails without sending")
    parser.add_argument("--test", metavar="EMAIL", nargs="+", help="Send one or more test emails, then exit")
    parser.add_argument(
        "--send-examples",
        action="store_true",
        help="Send example emails to Behzad and Bardia before the CSV campaign",
    )
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompt for real bulk sends")
    return parser.parse_args()


def send_one(business: Business, subject: str, log_path: Path, label: str) -> bool:
    text = build_email_text(business)
    html = build_email_html(business)
    ok, message = mailgun_send(business.email, subject, text, html)
    status = "SUCCESS" if ok else "FAILED"
    log_result(log_path, business.email, status, f"{label} {message}")
    print(f"{status}: {business.email}")
    if not ok:
        print(message)
    return ok


def main() -> int:
    args = parse_args()
    log_path = Path(args.log)

    if args.test:
        ok_all = True
        for index, raw_email in enumerate(args.test, start=1):
            test_email = normalize_email(raw_email)
            if not is_valid_email(test_email):
                print(f"Invalid test email: {raw_email}", file=sys.stderr)
                ok_all = False
                continue
            if args.dry_run:
                print_preview(fake_business_for_test(test_email), args.subject)
                continue
            print(f"Sending test email to {test_email}...")
            ok_all = send_one(fake_business_for_test(test_email), args.subject, log_path, "TEST") and ok_all
            if index < len(args.test):
                time.sleep(SEND_DELAY_SECONDS)
        return 0 if ok_all else 1

    csv_path = Path(args.csv)
    skip_path = Path(args.skip)
    businesses = read_businesses(csv_path)
    skip_emails = read_skip_list(skip_path)
    already_sent = read_sent_log(log_path)
    recipients = eligible_rows(businesses, skip_emails, already_sent, log_path)

    print(f"Loaded rows: {len(businesses)}")
    print(f"Skipped by blacklist/already-sent/invalid: {len(businesses) - len(recipients)}")
    example_recipients = example_businesses() if args.send_examples else []
    print(f"Ready to send: {len(recipients)}")
    if args.send_examples:
        print(f"Example emails first: {', '.join(b.email for b in example_recipients)}")

    if args.dry_run:
        for business in example_recipients:
            print_preview(business, f"[EXAMPLE] {args.subject}")
        for business in recipients:
            print_preview(business, args.subject)
        total = len(example_recipients) + len(recipients)
        print(f"DRY RUN ONLY: no emails sent. Would send {total} emails.")
        return 0

    total_real_sends = len(example_recipients) + len(recipients)
    if total_real_sends == 0:
        print("Nothing to send.")
        return 0

    if not args.yes:
        confirmation = input(f"Send {total_real_sends} real emails through Mailgun? Type SEND to continue: ")
        if confirmation.strip() != "SEND":
            print("Cancelled.")
            return 0

    send_plan = [("EXAMPLE", business) for business in example_recipients]
    send_plan.extend(("CAMPAIGN", business) for business in recipients)

    for index, (label, business) in enumerate(send_plan, start=1):
        print(f"[{index}/{len(send_plan)}] {label}", end=" ")
        send_one(business, args.subject, log_path, label)
        if index < len(send_plan):
            time.sleep(SEND_DELAY_SECONDS)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
