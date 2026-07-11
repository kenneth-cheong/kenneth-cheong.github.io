import { Link } from 'react-router-dom';
import { TERMS_VERSION } from '@shared/catalog.mjs';

// Terms of Service + Privacy Policy. These are starter templates covering the
// standard sections — HAVE A LAWYER REVIEW before relying on them commercially.
// Rendered both logged-out (public) and logged-in (inside the app shell).

const UPDATED = '10 July 2026';
const COMPANY = 'Digimetrics';
const CONTACT = 'support@mediaone.co';

function Shell({ title, children }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Link to="/" className="text-sm text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">← Back</Link>
      <h1 className="mt-4 text-3xl font-bold">{title}</h1>
      <p className="mt-1 text-sm text-faint">Last updated: {UPDATED} · v{TERMS_VERSION}</p>
      <div className="prose prose-slate mt-6 max-w-none text-sm leading-relaxed text-body [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-bold [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
      <p className="mt-8 rounded-lg bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
        This is a template for review and is not legal advice. Please have it reviewed by a qualified lawyer for your jurisdiction.
      </p>
    </div>
  );
}

export function Terms() {
  return (
    <Shell title="Terms of Service">
      <p>These Terms govern your use of {COMPANY} (the "Service"). By signing in or using the Service you agree to them. If you do not agree, do not use the Service.</p>
      <h2>1. Accounts</h2>
      <p>You sign in with Google. You are responsible for activity under your account and for keeping your access secure. You must be at least 18 and provide accurate information.</p>
      <h2>2. Plans, credits & billing</h2>
      <p>Paid plans and credit top-ups are billed through Stripe. Monthly plan credits reset each billing cycle and do not roll over; purchased top-up credits roll over. Fees are stated at checkout and are non-refundable except where required by law. You can change or cancel your plan at any time from your account; cancellation takes effect at the end of the current period.</p>
      <h2>3. Acceptable use</h2>
      <p>You agree not to misuse the Service, including: reverse engineering, reselling access without permission, scraping, overloading the system, infringing others' rights, or using outputs unlawfully. We may suspend accounts that violate these Terms.</p>
      <h2>4. Your content & outputs</h2>
      <p>You retain rights to the inputs you submit. You are responsible for how you use generated outputs. AI-generated results may be inaccurate — verify before relying on them. We may process your inputs to provide and improve the Service.</p>
      <h2>5. Recommendations are informational only — no professional advice</h2>
      <p>The Service produces audits, scores, suggestions, action plans, and other recommendations using automated and AI-based methods (collectively, "Recommendations"). Recommendations are provided for general informational purposes only, are generated from data that may be incomplete, outdated, or inaccurate, and do <strong>not</strong> constitute professional, legal, financial, marketing, or business advice. They are not a substitute for your own judgement or that of a qualified professional. You are solely responsible for reviewing, validating, and deciding whether to act on any Recommendation, and for any results, decisions, expenditures, or changes you make in reliance on it. {COMPANY} does not warrant that following any Recommendation will produce any particular outcome (including rankings, traffic, conversions, or revenue) and accepts no responsibility for actions taken, or not taken, based on Recommendations.</p>
      <h2>6. Third-party services</h2>
      <p>The Service integrates third parties (e.g. Google Search Console / Analytics / Ads, and AI providers). Your use of those integrations is also subject to their terms.</p>
      <h2>7. Availability & disclaimers</h2>
      <p>The Service is provided "as is" without warranties of any kind. We do not guarantee uninterrupted or error-free operation, or any particular result (including rankings, traffic, or revenue).</p>
      <h2>8. Limitation of liability</h2>
      <p>To the maximum extent permitted by law, {COMPANY} is not liable for indirect, incidental, or consequential damages, and our total liability is limited to the amount you paid in the 12 months before the claim.</p>
      <h2>9. Indemnification</h2>
      <p>You agree to defend, indemnify, and hold harmless {COMPANY}, its affiliates, and their respective officers, directors, employees, and agents from and against any and all claims, demands, liabilities, damages, losses, costs, and expenses (including reasonable legal fees) arising out of or related to: (a) your use of the Service or the outputs and Recommendations it generates; (b) your reliance on, implementation of, or decisions based on any Recommendation; (c) any content or inputs you submit; (d) your violation of these Terms or of any applicable law; or (e) your infringement of any third party's rights. This obligation survives termination of your account and these Terms.</p>
      <h2>10. Termination</h2>
      <p>You may stop using the Service and delete your account at any time. We may suspend or terminate access for breach of these Terms.</p>
      <h2>11. Changes</h2>
      <p>We may update these Terms; material changes will be notified in-app or by email, and we may require you to re-accept them before continuing to use the Service. Continued use after changes means you accept them.</p>
      <h2>12. Contact</h2>
      <p>Questions: <a className="text-brand-600 dark:text-brand-400" href={`mailto:${CONTACT}`}>{CONTACT}</a>. See also our <Link className="text-brand-600 dark:text-brand-400" to="/legal/privacy">Privacy Policy</Link>.</p>
    </Shell>
  );
}

export function Privacy() {
  return (
    <Shell title="Privacy Policy">
      <p>This policy explains what {COMPANY} collects, how we use it, and your rights.</p>
      <h2>1. What we collect</h2>
      <ul>
        <li><strong>Account data:</strong> your name, email and profile photo from Google sign-in.</li>
        <li><strong>Usage data:</strong> tools you run, inputs/outputs, credit ledger, support tickets, tracked keywords and projects.</li>
        <li><strong>Billing data:</strong> handled by Stripe; we store a customer reference and invoice metadata, not your full card details.</li>
        <li><strong>Integrations:</strong> if you connect Google Search Console / Analytics / Ads, we store access tokens (encrypted) to fetch your data on your behalf.</li>
        <li><strong>Session recordings & analytics:</strong> to understand how the app is used and improve its design, we record anonymised product-usage sessions (mouse movement, clicks, scrolling, and the pages you visit) via Microsoft Clarity. Text you type into fields is masked and not captured. These recordings are used internally for usability and troubleshooting only.</li>
      </ul>
      <h2>2. How we use it</h2>
      <p>To provide the Service, process payments, run the tools you request, provide support, prevent abuse, and meet legal obligations.</p>
      <h2>3. Sharing</h2>
      <p>We share data only with processors that run the Service: cloud hosting (AWS), payments (Stripe), product analytics and session recording (Microsoft Clarity), and AI/data providers needed to fulfil a tool you run. We do not sell your personal data.</p>
      <h2>4. Retention</h2>
      <p>We keep your data while your account is active. When you delete your account, your data is removed from our systems (some records, such as invoices, may be retained where law requires).</p>
      <h2>5. Your rights</h2>
      <p>You can access, export, correct, or delete your data. Use <Link className="text-brand-600 dark:text-brand-400" to="/account">Account → Your data</Link> to export everything we hold or permanently delete your account, or contact us.</p>
      <h2>6. Security</h2>
      <p>We use encryption in transit and at rest, scoped access controls, and integration tokens encrypted at rest. No system is perfectly secure, but we work to protect your data.</p>
      <h2>7. International transfers</h2>
      <p>Data is processed in AWS (Asia Pacific) and by our processors, which may involve transfers across borders under appropriate safeguards.</p>
      <h2>8. Contact</h2>
      <p>Privacy questions or requests: <a className="text-brand-600 dark:text-brand-400" href={`mailto:${CONTACT}`}>{CONTACT}</a>.</p>
    </Shell>
  );
}
