import { useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { NDA_VERSION } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';

// Soft-launch Free Trial + NDA gate. Shown by Layout to any signed-in trial user
// who hasn't accepted the current NDA_VERSION (after they've accepted the base
// Terms). Not dismissible — completing it is required to use the trial. The
// company form + acceptance are persisted server-side (tied to the account, so
// it's never re-asked across devices) and tom@mediaone.co is notified.
const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', autoComplete: 'name' },
  { key: 'organisation', label: 'Organisation', type: 'text', autoComplete: 'organization' },
  { key: 'uen', label: 'UEN', type: 'text', placeholder: 'e.g. 201912345A' },
  { key: 'telephone', label: 'Telephone', type: 'tel', placeholder: '+65 …', autoComplete: 'tel' },
  { key: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
];

const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());

export default function TrialNdaGate() {
  const { user, acceptNda } = useAuth();
  const [form, setForm] = useState(() => ({
    name: user?.name || '',
    organisation: '',
    uen: '',
    telephone: '',
    email: user?.email || '',
  }));
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState('');
  const [showTerms, setShowTerms] = useState(false);

  const set = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    if (errors[k]) setErrors((x) => ({ ...x, [k]: false }));
  };

  const submit = async () => {
    if (busy) return;
    const errs = {};
    for (const f of FIELDS) {
      if (!form[f.key].trim()) errs[f.key] = true;
    }
    if (form.email.trim() && !validEmail(form.email)) errs.email = true;
    if (!agreed) errs.agreed = true;
    setErrors(errs);
    if (Object.keys(errs).length) {
      setServerErr('Please complete all fields and accept the terms.');
      return;
    }
    setServerErr('');
    setBusy(true);
    try {
      await acceptNda({
        accepted: true,
        version: NDA_VERSION,
        name: form.name.trim(),
        organisation: form.organisation.trim(),
        uen: form.uen.trim(),
        telephone: form.telephone.trim(),
        email: form.email.trim(),
      });
      // On success the user's onboarding now has acceptedNda → Layout drops the gate.
    } catch (e) {
      setBusy(false);
      setServerErr(e?.message || 'Something went wrong. Please try again.');
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm sm:items-center">
      <div className="my-8 w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl sm:p-8">
        <div className="flex items-center gap-2 text-brand-600">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white"><ShieldCheck size={20} aria-hidden /></span>
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Soft launch · Free trial</span>
        </div>

        <h1 className="mt-4 text-xl font-bold text-slate-900">Activate your free trial</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Please confirm your details and accept the Free Trial &amp; NDA Terms to activate
          your 180-day trial. You only need to do this once.
        </p>

        <div className="mt-5 space-y-3">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`nda-${f.key}`} className="mb-1 block text-xs font-semibold text-slate-600">
                {f.label} <span className="text-rose-500">*</span>
              </label>
              <input
                id={`nda-${f.key}`}
                type={f.type}
                value={form[f.key]}
                onChange={set(f.key)}
                placeholder={f.placeholder}
                autoComplete={f.autoComplete}
                className={`w-full rounded-xl border bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-500/20 ${errors[f.key] ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`}
              />
            </div>
          ))}
        </div>

        <label className={`mt-5 flex cursor-pointer items-start gap-3 rounded-xl border p-3 hover:border-brand-300 ${errors.agreed ? 'border-rose-400 bg-rose-50' : 'border-slate-200'}`}>
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => { setAgreed(e.target.checked); if (errors.agreed) setErrors((x) => ({ ...x, agreed: false })); }}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm leading-relaxed text-slate-700">
            By clicking &lsquo;Accept and Activate Free Trial&rsquo;, I confirm that I am authorised to accept these{' '}
            <button type="button" onClick={() => setShowTerms(true)} className="font-semibold text-brand-600 underline hover:text-brand-700">
              Digimetrics Free Trial and NDA Terms
            </button>{' '}
            on behalf of myself and/or my organisation. I agree to keep Digimetrics&rsquo; non-public product
            information confidential, use the free trial only for evaluation purposes, and provide feedback where
            possible through the &lsquo;Report a problem&rsquo; feature or by emailing{' '}
            <a href="mailto:tom@mediaone.co" className="font-medium text-brand-600 hover:text-brand-700">tom@mediaone.co</a>.
          </span>
        </label>

        {serverErr && <p className="mt-3 text-sm text-rose-600">{serverErr}</p>}

        <button
          onClick={submit}
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Activating…' : 'Accept and Activate Free Trial'}
        </button>
        <p className="mt-3 text-center text-xs text-slate-400">
          MediaOne Business Group Pte Ltd — owner/operator of Digimetrics.
        </p>
      </div>

      {showTerms && <TermsModal onClose={() => setShowTerms(false)} />}
    </div>
  );
}

// Full NDA text, shown when the user clicks the inline "Terms" link.
function TermsModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-bold text-slate-900">Digimetrics Free Trial &amp; Non-Disclosure Agreement</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-slate-500 hover:bg-slate-200"><X size={18} /></button>
        </div>
        <div className="space-y-3 overflow-y-auto px-6 py-5 text-sm leading-relaxed text-slate-700">
          <p className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            This Free Trial and Non-Disclosure Agreement is made between <b>MediaOne Business Group Pte Ltd</b>,
            the owner/operator of Digimetrics (the &ldquo;Company&rdquo;), and the individual or organisation
            invited to access and use Digimetrics (the &ldquo;Trial User&rdquo;). Together, the &ldquo;Parties&rdquo;.
          </p>
          <p>
            This Agreement does not require the Trial User to enter signatory details or affix a physical signature.
            Acceptance is recorded electronically through the Company&rsquo;s &ldquo;Agree and Submit&rdquo; process
            and/or the Trial User&rsquo;s access to the free trial.
          </p>

          <Section n="1" title="Purpose">
            <p>The Company is offering the Trial User early access to Digimetrics as part of a soft launch / free trial programme.</p>
            <p>The purpose of this trial is to allow selected partners and customers to test, evaluate and provide feedback on the form, function, usability, features, performance and commercial usefulness of Digimetrics.</p>
          </Section>
          <Section n="2" title="Free Trial Period">
            <p>The Trial User will be given access to Digimetrics for a free trial period of 180 days from the date of account activation, unless extended or terminated earlier by the Company.</p>
          </Section>
          <Section n="3" title="Trial Credits">
            <p>As part of the free trial, the Trial User will receive 2,500 Digimetrics credits, with an estimated value of $99, or any other terms as provided by the Company separately. These credits are provided free of charge for trial and evaluation purposes only. The credits:</p>
            <List items={['have no cash value;', 'cannot be exchanged for money;', 'cannot be transferred, resold or assigned to another party;', 'may only be used within Digimetrics; and', 'may expire at the end of the free trial period unless otherwise agreed in writing.']} />
          </Section>
          <Section n="4" title="Confidential Information">
            <p>During the free trial, the Trial User may receive or access confidential and proprietary information relating to Digimetrics, including but not limited to:</p>
            <List items={['product features, workflows and functions;', 'software design, user interface and user experience;', 'algorithms, processes, analytics, reports and outputs;', 'business models, pricing, commercial plans and product roadmap;', 'technical information, system architecture and operational processes;', 'marketing, sales or customer materials; and', 'any other information that is not publicly available.']} />
            <p>All such information shall be treated as confidential, whether provided verbally, visually, electronically, through the platform, or in any other form.</p>
          </Section>
          <Section n="5" title="Confidentiality Obligations">
            <p>The Trial User agrees to:</p>
            <List items={['keep all Confidential Information strictly confidential;', 'use the Confidential Information only for evaluating and testing Digimetrics;', "not disclose the Confidential Information to any third party without the Company's prior written consent;", 'take reasonable steps to prevent unauthorised access, copying, misuse or disclosure;', 'not publish, post, share or circulate screenshots, reports, outputs, demonstrations or platform information without written approval from the Company; and', 'immediately notify the Company if the Trial User becomes aware of any unauthorised use or disclosure.']} />
          </Section>
          <Section n="6" title="Restrictions on Use">
            <p>The Trial User shall not:</p>
            <List items={['copy, reproduce, modify, reverse engineer, decompile or attempt to derive the source code or underlying logic of Digimetrics;', 'use Digimetrics to develop, improve or assist a competing product or service;', 'allow unauthorised persons to access the trial account;', 'resell, sublicense or commercially exploit the trial access;', 'misuse the platform or attempt to bypass usage limits, credits, security or access controls; or', 'use Digimetrics for any unlawful, harmful, misleading or unauthorised purpose.']} />
          </Section>
          <Section n="7" title="Feedback and Testimonials">
            <p>As part of the free trial, the Company would appreciate feedback from the Trial User on the form, function, usability, accuracy, performance and usefulness of Digimetrics. The Trial User may provide feedback by:</p>
            <List items={['using the “Report a problem” feature within Digimetrics; or', 'emailing feedback to tom@mediaone.co.']} />
            <p>The Trial User agrees that any feedback, suggestions, comments, ideas, issue reports or recommendations provided to the Company may be used by the Company to improve, modify, develop, market or commercialise Digimetrics without any payment, royalty or obligation to the Trial User.</p>
            <p>The Trial User may also choose to provide a testimonial, review, endorsement, quote, case comment or other positive statement about Digimetrics.</p>
            <p>By providing a testimonial, the Trial User agrees that the Company may use, reproduce, publish, display and distribute the testimonial for marketing, sales, investor, partnership, website, social media, presentation and promotional purposes.</p>
            <p>The Trial User further agrees that the Company may identify the testimonial provider by name, designation, company name, brand name, industry and/or company logo, where such information has been provided or is already reasonably known to the Company.</p>
            <p>The Company may make minor edits to the testimonial for grammar, clarity, length or formatting, provided that such edits do not materially change the meaning of the testimonial.</p>
            <p>The Trial User confirms that any testimonial provided is truthful, voluntary and based on its actual experience using Digimetrics.</p>
            <p>The Trial User shall not disclose any confidential, sensitive or third-party information in its feedback or testimonial unless it has the right to do so.</p>
          </Section>
          <Section n="8" title="Ownership and Intellectual Property">
            <p>All rights, title and interest in Digimetrics, including all software, designs, content, reports, workflows, processes, features, improvements, know-how, trade secrets, trademarks and intellectual property, shall remain the exclusive property of the Company or its licensors.</p>
            <p>Nothing in this Agreement transfers any ownership rights to the Trial User. The Trial User is granted only a limited, temporary, non-exclusive, non-transferable and revocable right to use Digimetrics during the free trial period for evaluation purposes.</p>
          </Section>
          <Section n="9" title="Trial User Data">
            <p>The Trial User is responsible for ensuring that any data, content or materials uploaded or entered into Digimetrics may lawfully be used for testing and evaluation.</p>
            <p>The Trial User shall not upload personal data, confidential client information, sensitive commercial information or third-party proprietary information unless it has obtained all necessary rights, permissions and consents.</p>
          </Section>
          <Section n="10" title="No Warranty">
            <p>Digimetrics is provided during the free trial on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis. As this is a soft launch / free trial, the Trial User acknowledges that Digimetrics may contain bugs, errors, incomplete features, limitations or service interruptions.</p>
            <p>The Company does not guarantee that Digimetrics will be error-free, uninterrupted, fully accurate or suitable for any specific commercial purpose during the trial period.</p>
          </Section>
          <Section n="11" title="Limitation of Liability">
            <p>To the maximum extent permitted by law, the Company shall not be liable for any indirect, incidental, consequential, special or loss-of-profit damages arising from the Trial User's use of Digimetrics during the free trial. The Trial User agrees that it uses Digimetrics at its own discretion and risk during the free trial period.</p>
          </Section>
          <Section n="12" title="Termination">
            <p>The Company may suspend or terminate the free trial at any time if:</p>
            <List items={['the Trial User breaches this Agreement;', 'the Trial User misuses Digimetrics;', 'continued access may pose a security, legal, operational or commercial risk; or', 'the Company decides to end or modify the free trial programme.']} />
            <p>Upon termination or expiry of the free trial, the Trial User must stop using Digimetrics and must not retain, copy, share or misuse any Confidential Information.</p>
          </Section>
          <Section n="13" title="Survival">
            <p>The confidentiality, intellectual property, feedback, testimonials, restriction of use and limitation of liability provisions shall continue to apply even after the free trial ends.</p>
          </Section>
          <Section n="14" title="Governing Law">
            <p>This Agreement shall be governed by and interpreted in accordance with the laws of Singapore. The Parties agree to submit to the exclusive jurisdiction of the courts of Singapore.</p>
          </Section>
          <Section n="15" title="Electronic Acceptance and Proof of Consent">
            <p>By clicking &ldquo;Agree and Submit&rdquo;, creating a trial account, accessing Digimetrics, or using the free trial credits, the Trial User confirms that it has read, understood and agreed to be bound by this Agreement.</p>
            <p>If the person accepting this Agreement does so on behalf of an organisation, that person represents that he or she has authority to accept this Agreement on behalf of that organisation.</p>
            <p>No physical signature, handwritten signature or manual entry of signatory details is required for this Agreement to take effect.</p>
            <p>The Company may rely on the electronic acceptance record as proof of consent. Such record may include the Trial User&rsquo;s account details, email address, organisation details, date and time of acceptance, IP address, browser or device information, acceptance version, and a copy or record of the terms accepted.</p>
            <p>The Trial User also acknowledges and agrees that any feedback or testimonial provided may be used by the Company in accordance with the Feedback and Testimonials section of this Agreement, including identifying the testimonial provider by name, designation, company name, brand name, industry and/or company logo where applicable.</p>
          </Section>
        </div>
        <div className="border-t border-slate-200 px-6 py-3 text-right">
          <button onClick={onClose} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Close</button>
        </div>
      </div>
    </div>
  );
}

function Section({ n, title, children }) {
  return (
    <div>
      <h3 className="mt-4 text-sm font-bold text-brand-700">{n}. {title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function List({ items }) {
  return (
    <ol className="ml-5 list-[lower-alpha] space-y-1">
      {items.map((t, i) => <li key={i}>{t}</li>)}
    </ol>
  );
}
