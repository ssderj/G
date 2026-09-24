# Privacy Policy — Inkroot

**⚠️ This is a starting-point template, not a finished legal document.** It's written to match
what Inkroot's code actually does (checked against `supabase/schema.sql`, `src/lib/auth.js`, and
`src/writing/import-export.jsx`), but every bracketed `[placeholder]` needs your real information,
and the whole thing needs review by a lawyer licensed in your jurisdiction before you publish it
or let anyone sign up. Privacy law varies a lot by where your users are (GDPR, CCPA/CPRA, and
others each impose different specific obligations this draft doesn't fully spell out).

**Effective date:** [DATE]
**Last updated:** [DATE]

## Who we are

Inkroot ("we," "us," "our") is operated by [LEGAL ENTITY NAME], located in [ADDRESS /
JURISDICTION]. Contact us about privacy at [PRIVACY EMAIL].

## What we collect

**Account information.** If you sign in with Google, we receive your email address and basic
profile info from Google. If you register a passkey, your device handles the cryptographic
credential; we store only what's needed to recognize it on future sign-ins. We do not support
or store passwords.

**Your writing and project data.** Manuscripts, chapters, characters, world-building notes,
timelines, and other project content you create are stored so they sync across your devices.
This data is private to your account by default — we do not read, scan, or use it to train any
model, and no one else can access it unless you choose to publish it (see below).

**Public profile and social data.** If you use Grand Library or Guild features, your display
name/pen name, and any books, reviews, guild posts, or reactions you choose to publish, are
visible to other users or the public, as described in-app at the point you publish them.

**Uploaded images.** Avatars, guild crests, book covers, and in-manuscript images you upload are
stored in our file storage. Avatars, crests, and covers are public; in-manuscript images are
private to your account.

**Technical data.** Standard infrastructure logs (IP address, browser type, timestamps) are
collected by our hosting/database provider for security and operational purposes.

## What we don't collect

We don't have a payment processor connected yet, so we don't collect or store payment card
information. [Update this section immediately once/if that changes — payment data has its own
separate compliance requirements (PCI DSS), and this policy needs to name your processor, e.g.
Stripe, once one exists.]

## How we use your data

- To provide the core service: storing and syncing your writing across your devices.
- To operate features you opt into: publishing, guild social features, reviews and follows.
- To maintain security and prevent abuse of the service.
- We do not sell your personal information, and we do not use your private manuscript content
  for advertising, analytics profiling, or to train any AI/ML model.

## Who we share data with

We use the following service providers (subprocessors) to operate Inkroot:

- **Supabase** — database, authentication, and file storage hosting. [State which region your
  Supabase project is hosted in, since this matters for international transfer rules.]
- **Google** — OAuth sign-in, if you choose that sign-in method.

We do not otherwise sell or share your personal data with third parties, except where required
by law (e.g., a valid legal request) or to protect the rights, safety, or property of Inkroot,
our users, or the public.

## Data retention and deletion

You can request account deletion at any time from [SETTINGS LOCATION]. When you do:

- Your account is deactivated immediately and hidden from other users.
- You have [30] days to sign back in and cancel the deletion if you change your mind or the
  request wasn't you.
- After that grace period, your account and associated private data are permanently deleted.
  Content you published publicly (e.g., guild posts others have replied to) may be anonymized
  rather than deleted outright, so it doesn't leave holes in conversations other users are part
  of — you'll be described as a removed/former user rather than by name.

[This describes the *recommended* soft-delete pattern discussed separately — confirm this
matches what's actually implemented before publishing this policy, since the policy has to
describe real behavior, not aspirational behavior.]

## Your rights

Depending on where you live, you may have rights to access, correct, export, or delete your
personal data, and to object to or restrict certain processing. Contact us at [PRIVACY EMAIL] to
exercise these rights. [Add specific GDPR (EU/UK) and CCPA/CPRA (California) rights language
here if you have or expect users in those regions — the specific rights and response-time
requirements differ between them.]

## Children's privacy

Inkroot is not directed at children under [13/16 — pick based on your jurisdiction and target
audience], and we do not knowingly collect personal information from children under that age.
[This needs to match whatever age floor you put in your Terms of Service.]

## Security

We use industry-standard measures to protect your data, including encryption in transit,
database-level access controls (row-level security scoping every user to their own data), and
restricted internal access. No system is 100% secure, and we can't guarantee absolute security.

## Changes to this policy

We'll post updates here and update the "Last updated" date above. [Consider adding: for material
changes, how you'll notify users — e.g., email or in-app notice.]

## Contact

[PRIVACY EMAIL]
[MAILING ADDRESS, if legally required in your jurisdiction]
