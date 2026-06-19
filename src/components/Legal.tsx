/* ============================================================
   KANBO — public Privacy Policy & Terms pages. Standalone, signed-out
   accessible (loaded directly at /privacy and /terms from main.tsx) so the
   URLs are stable for Google OAuth verification and footer links.
   ============================================================ */
import { KanboLogo } from "./primitives";

const UPDATED = "20 June 2026";
const CONTACT = "hello@kanbo.co.uk";

const wrap: React.CSSProperties = { position: "relative", minHeight: "100vh", overflowX: "hidden" };
const inner: React.CSSProperties = { position: "relative", zIndex: 1, maxWidth: 760, margin: "0 auto", padding: "0 24px 80px" };

function H({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em", margin: "30px 0 10px" }}>{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 14.5, lineHeight: 1.7, color: "var(--ink-2)", margin: "0 0 12px" }}>{children}</p>;
}
function LI({ children }: { children: React.ReactNode }) {
  return <li style={{ fontSize: 14.5, lineHeight: 1.7, color: "var(--ink-2)", marginBottom: 6 }}>{children}</li>;
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={wrap}>
      <div className="app-bg" /><div className="app-grid" />
      <div style={{ position: "relative", zIndex: 1 }}>
        <nav style={{ maxWidth: 760, margin: "0 auto", display: "flex", alignItems: "center", gap: 12, padding: "20px 24px" }}>
          <a href="/" style={{ display: "inline-flex", alignItems: "center", gap: 11, textDecoration: "none", color: "inherit" }}>
            <KanboLogo size={28} />
            <span style={{ fontFamily: "var(--font-head)", fontSize: 18, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" }}>Kanbo</span>
          </a>
          <a href="/" style={{ marginLeft: "auto", fontSize: 13.5, fontWeight: 600, color: "var(--accent)", textDecoration: "none" }}>← Back to home</a>
        </nav>
        <div style={inner}>
          <h1 style={{ fontSize: "clamp(28px, 4vw, 38px)", fontWeight: 700, letterSpacing: "-0.02em", margin: "20px 0 6px" }}>{title}</h1>
          <p style={{ fontSize: 13, color: "var(--ink-4)", marginBottom: 8 }}>Last updated {UPDATED}</p>
          {children}
          <p style={{ fontSize: 13.5, color: "var(--ink-4)", marginTop: 36, borderTop: "1px solid var(--hairline)", paddingTop: 18 }}>
            Questions? Email <a href={`mailto:${CONTACT}`} style={{ color: "var(--accent)" }}>{CONTACT}</a>.
          </p>
        </div>
      </div>
    </div>
  );
}

export function PrivacyPolicy() {
  return (
    <Shell title="Privacy Policy">
      <P>Kanbo (“we”, “us”) is a productivity app that turns your tasks into a planned day. This policy explains what we collect, why, and the choices you have. We aim to collect as little as possible.</P>

      <H>Who we are</H>
      <P>Kanbo is operated from the United Kingdom. For any privacy question, contact <a href={`mailto:${CONTACT}`} style={{ color: "var(--accent)" }}>{CONTACT}</a>.</P>

      <H>What we collect</H>
      <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
        <LI><strong>Account details</strong> — your name and email address, so your account is more than an anonymous login and teammates can recognise you.</LI>
        <LI><strong>Your content</strong> — the tasks, projects, comments, files and settings you create in Kanbo.</LI>
        <LI><strong>Calendar data (only if you connect it)</strong> — we request <strong>read-only</strong> access to your Google or Microsoft calendar so Kanbo can plan around your meetings. We never edit or delete calendar events.</LI>
        <LI><strong>Basic usage &amp; diagnostics</strong> — limited technical data (e.g. error reports and session activity) to keep Kanbo reliable.</LI>
      </ul>

      <H>How we use it</H>
      <P>To provide and improve Kanbo: to store and sync your work, plan your day around your calendar, prioritise tasks, send the emails you’d expect (early-access approval, optional reminders), and keep the service secure.</P>
      <P>We do <strong>not</strong> sell your data, and we do not use your task content for advertising.</P>

      <H>Service providers we rely on</H>
      <P>We use a small set of trusted processors to run Kanbo: <strong>Supabase</strong> (database, authentication and file storage), <strong>Vercel</strong> (hosting), <strong>Resend</strong> (transactional email), and, where you opt in, <strong>Google</strong> or <strong>Microsoft</strong> (read-only calendar) and an AI provider used to help prioritise your day. Billing, when introduced, will use <strong>Stripe</strong>. Each only processes the data needed for its function.</P>

      <H>Where your data lives &amp; how it’s protected</H>
      <P>Your data is stored on managed cloud infrastructure and protected in transit and at rest. Access between workspaces is isolated by row-level security, so people can only see data in workspaces they’ve been given access to. Calendar tokens are stored server-side and are never exposed to other users.</P>

      <H>Your rights</H>
      <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
        <LI><strong>Export</strong> — download your data at any time from your account settings.</LI>
        <LI><strong>Delete</strong> — delete your account and its data at any time; you can also disconnect a calendar to remove its tokens.</LI>
        <LI><strong>Access &amp; correction</strong> — you can view and edit your information in the app, or contact us for help.</LI>
      </ul>

      <H>Data retention</H>
      <P>We keep your data while your account is active. When you delete your account, we delete your associated data, except where we’re required to retain limited records by law.</P>

      <H>Cookies</H>
      <P>Kanbo uses only the storage needed to keep you signed in and remember your preferences. We don’t use third-party advertising cookies.</P>

      <H>Children</H>
      <P>Kanbo isn’t directed at children under 16, and we don’t knowingly collect their data.</P>

      <H>Changes</H>
      <P>We’ll update this policy as Kanbo evolves and revise the “last updated” date above. Significant changes will be communicated in-app or by email.</P>
    </Shell>
  );
}

export function Terms() {
  return (
    <Shell title="Terms of Service">
      <P>These terms govern your use of Kanbo. By creating an account or using the service, you agree to them.</P>

      <H>Early access</H>
      <P>Kanbo is currently in free early access. Access is granted by approval, features may change, and the service is provided “as is” while we build. We may add paid plans later; if we do, you’ll get clear notice well in advance.</P>

      <H>Your account</H>
      <P>You’re responsible for activity under your account and for keeping your login secure. Provide accurate information and let us know of any unauthorised use.</P>

      <H>Acceptable use</H>
      <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
        <LI>Don’t use Kanbo for anything unlawful, or to store or share unlawful, harmful or infringing content.</LI>
        <LI>Don’t attempt to disrupt, reverse-engineer, or gain unauthorised access to the service or other users’ data.</LI>
        <LI>Don’t abuse the service (e.g. excessive automated requests) in a way that degrades it for others.</LI>
      </ul>

      <H>Your content</H>
      <P>You own the content you create in Kanbo. You grant us the limited permission needed to host and process it so we can provide the service to you.</P>

      <H>Availability</H>
      <P>We work to keep Kanbo reliable but don’t guarantee uninterrupted or error-free service, especially during early access. We may modify or discontinue features.</P>

      <H>Termination</H>
      <P>You can stop using Kanbo and delete your account at any time. We may suspend or terminate accounts that breach these terms or put the service or other users at risk.</P>

      <H>Liability</H>
      <P>To the extent permitted by law, Kanbo is provided without warranties, and our liability for any claim relating to the service is limited. Nothing in these terms excludes liability that cannot be excluded by law.</P>

      <H>Contact</H>
      <P>Questions about these terms? Email <a href={`mailto:${CONTACT}`} style={{ color: "var(--accent)" }}>{CONTACT}</a>.</P>
    </Shell>
  );
}
