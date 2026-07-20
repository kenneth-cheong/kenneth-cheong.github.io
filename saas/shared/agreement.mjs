// Single source of truth for the Digimetrics Free Trial + NDA terms.
// Rendered on-screen by the frontend TrialNdaGate "Terms" modal AND embedded
// into the Acceptance Record PDF (saas/backend/src/lib/pdf.mjs), so the document
// a user signs and the copy attached to their proof-of-consent can never drift.
// When the wording changes, bump NDA_VERSION in catalog.mjs in the same change.

export const AGREEMENT_TITLE = 'Digimetrics Free Trial & Non-Disclosure Agreement';

// The two intro paragraphs shown before Section 1. The first is visually boxed
// in the on-screen modal.
export const AGREEMENT_INTRO = [
  {
    text:
      'This Free Trial and Non-Disclosure Agreement is made between MediaOne Business Group Pte Ltd, the authorised licensee and operator of Digimetrics (the “Company”), and the individual or organisation invited to access and use Digimetrics (the “Trial User”). Together, the “Parties”. Digimetrics and its underlying platform are owned by Apsolute.ai Pte Ltd.',
    boxed: true,
  },
  {
    text:
      'This Agreement does not require the Trial User to enter signatory details or affix a physical signature. Acceptance is recorded electronically through the Company’s “Agree and Submit” process and/or the Trial User’s access to the free trial.',
  },
];

// Each section: { n, title, blocks }. A block is either { p } (paragraph) or
// { list } (lettered (a), (b), … list).
export const AGREEMENT_SECTIONS = [
  {
    n: '1',
    title: 'Purpose',
    blocks: [
      { p: 'The Company is offering the Trial User early access to Digimetrics as part of a soft launch / free trial programme.' },
      { p: 'The purpose of this trial is to allow selected partners and customers to test, evaluate and provide feedback on the form, function, usability, features, performance and commercial usefulness of Digimetrics.' },
    ],
  },
  {
    n: '2',
    title: 'Free Trial Period',
    blocks: [
      { p: 'The Trial User will be given access to Digimetrics for a free trial period of 180 days from the date of account activation, unless extended or terminated earlier by the Company.' },
    ],
  },
  {
    n: '3',
    title: 'Trial Credits',
    blocks: [
      { p: 'As part of the free trial, the Trial User will receive 2,500 Digimetrics credits, with an estimated value of $99, or any other terms as provided by the Company separately. These credits are provided free of charge for trial and evaluation purposes only. The credits:' },
      {
        list: [
          'have no cash value;',
          'cannot be exchanged for money;',
          'cannot be transferred, resold or assigned to another party;',
          'may only be used within Digimetrics; and',
          'may expire at the end of the free trial period unless otherwise agreed in writing.',
        ],
      },
    ],
  },
  {
    n: '4',
    title: 'Confidential Information',
    blocks: [
      { p: 'During the free trial, the Trial User may receive or access confidential and proprietary information relating to Digimetrics, including but not limited to:' },
      {
        list: [
          'product features, workflows and functions;',
          'software design, user interface and user experience;',
          'algorithms, processes, analytics, reports and outputs;',
          'business models, pricing, commercial plans and product roadmap;',
          'technical information, system architecture and operational processes;',
          'marketing, sales or customer materials; and',
          'any other information that is not publicly available.',
        ],
      },
      { p: 'All such information shall be treated as confidential, whether provided verbally, visually, electronically, through the platform, or in any other form.' },
    ],
  },
  {
    n: '5',
    title: 'Confidentiality Obligations',
    blocks: [
      { p: 'The Trial User agrees to:' },
      {
        list: [
          'keep all Confidential Information strictly confidential;',
          'use the Confidential Information only for evaluating and testing Digimetrics;',
          "not disclose the Confidential Information to any third party without the Company's prior written consent;",
          'take reasonable steps to prevent unauthorised access, copying, misuse or disclosure;',
          'not publish, post, share or circulate screenshots, reports, outputs, demonstrations or platform information without written approval from the Company; and',
          'immediately notify the Company if the Trial User becomes aware of any unauthorised use or disclosure.',
        ],
      },
    ],
  },
  {
    n: '6',
    title: 'Restrictions on Use',
    blocks: [
      { p: 'The Trial User shall not:' },
      {
        list: [
          'copy, reproduce, modify, reverse engineer, decompile or attempt to derive the source code or underlying logic of Digimetrics;',
          'use Digimetrics to develop, improve or assist a competing product or service;',
          'allow unauthorised persons to access the trial account;',
          'resell, sublicense or commercially exploit the trial access;',
          'misuse the platform or attempt to bypass usage limits, credits, security or access controls; or',
          'use Digimetrics for any unlawful, harmful, misleading or unauthorised purpose.',
        ],
      },
    ],
  },
  {
    n: '7',
    title: 'Feedback and Testimonials',
    blocks: [
      { p: 'As part of the free trial, the Company would appreciate feedback from the Trial User on the form, function, usability, accuracy, performance and usefulness of Digimetrics. The Trial User may provide feedback by:' },
      {
        list: [
          'using the “Report a problem” feature within Digimetrics; or',
          'emailing feedback to tom@mediaone.co.',
        ],
      },
      { p: 'The Trial User agrees that any feedback, suggestions, comments, ideas, issue reports or recommendations provided to the Company may be used by the Company to improve, modify, develop, market or commercialise Digimetrics without any payment, royalty or obligation to the Trial User.' },
      { p: 'The Trial User may also choose to provide a testimonial, review, endorsement, quote, case comment or other positive statement about Digimetrics.' },
      { p: 'By providing a testimonial, the Trial User agrees that the Company may use, reproduce, publish, display and distribute the testimonial for marketing, sales, investor, partnership, website, social media, presentation and promotional purposes.' },
      { p: 'The Trial User further agrees that the Company may identify the testimonial provider by name, designation, company name, brand name, industry and/or company logo, where such information has been provided or is already reasonably known to the Company.' },
      { p: 'The Company may make minor edits to the testimonial for grammar, clarity, length or formatting, provided that such edits do not materially change the meaning of the testimonial.' },
      { p: 'The Trial User confirms that any testimonial provided is truthful, voluntary and based on its actual experience using Digimetrics.' },
      { p: 'The Trial User shall not disclose any confidential, sensitive or third-party information in its feedback or testimonial unless it has the right to do so.' },
    ],
  },
  {
    n: '8',
    title: 'Ownership and Intellectual Property',
    blocks: [
      { p: 'All rights, title and interest in Digimetrics, including all software, designs, content, reports, workflows, processes, features, improvements, know-how, trade secrets, trademarks and intellectual property, shall remain the exclusive property of the Company or its licensors.' },
      { p: 'Nothing in this Agreement transfers any ownership rights to the Trial User. The Trial User is granted only a limited, temporary, non-exclusive, non-transferable and revocable right to use Digimetrics during the free trial period for evaluation purposes.' },
    ],
  },
  {
    n: '9',
    title: 'Trial User Data',
    blocks: [
      { p: 'The Trial User is responsible for ensuring that any data, content or materials uploaded or entered into Digimetrics may lawfully be used for testing and evaluation.' },
      { p: 'The Trial User shall not upload personal data, confidential client information, sensitive commercial information or third-party proprietary information unless it has obtained all necessary rights, permissions and consents.' },
    ],
  },
  {
    n: '10',
    title: 'No Warranty',
    blocks: [
      { p: 'Digimetrics is provided during the free trial on an “as is” and “as available” basis. As this is a soft launch / free trial, the Trial User acknowledges that Digimetrics may contain bugs, errors, incomplete features, limitations or service interruptions.' },
      { p: 'The Company does not guarantee that Digimetrics will be error-free, uninterrupted, fully accurate or suitable for any specific commercial purpose during the trial period.' },
    ],
  },
  {
    n: '11',
    title: 'Limitation of Liability',
    blocks: [
      { p: "To the maximum extent permitted by law, the Company shall not be liable for any indirect, incidental, consequential, special or loss-of-profit damages arising from the Trial User's use of Digimetrics during the free trial. The Trial User agrees that it uses Digimetrics at its own discretion and risk during the free trial period." },
    ],
  },
  {
    n: '12',
    title: 'Termination',
    blocks: [
      { p: 'The Company may suspend or terminate the free trial at any time if:' },
      {
        list: [
          'the Trial User breaches this Agreement;',
          'the Trial User misuses Digimetrics;',
          'continued access may pose a security, legal, operational or commercial risk; or',
          'the Company decides to end or modify the free trial programme.',
        ],
      },
      { p: 'Upon termination or expiry of the free trial, the Trial User must stop using Digimetrics and must not retain, copy, share or misuse any Confidential Information.' },
    ],
  },
  {
    n: '13',
    title: 'Survival',
    blocks: [
      { p: 'The confidentiality, intellectual property, feedback, testimonials, restriction of use and limitation of liability provisions shall continue to apply even after the free trial ends.' },
    ],
  },
  {
    n: '14',
    title: 'Governing Law',
    blocks: [
      { p: 'This Agreement shall be governed by and interpreted in accordance with the laws of Singapore. The Parties agree to submit to the exclusive jurisdiction of the courts of Singapore.' },
    ],
  },
  {
    n: '15',
    title: 'Electronic Acceptance and Proof of Consent',
    blocks: [
      { p: 'By clicking “Agree and Submit”, creating a trial account, accessing Digimetrics, or using the free trial credits, the Trial User confirms that it has read, understood and agreed to be bound by this Agreement.' },
      { p: 'If the person accepting this Agreement does so on behalf of an organisation, that person represents that he or she has authority to accept this Agreement on behalf of that organisation.' },
      { p: 'No physical signature, handwritten signature or manual entry of signatory details is required for this Agreement to take effect.' },
      { p: 'The Company may rely on the electronic acceptance record as proof of consent. Such record may include the Trial User’s account details, email address, organisation details, date and time of acceptance, IP address, browser or device information, acceptance version, and a copy or record of the terms accepted.' },
      { p: 'The Trial User also acknowledges and agrees that any feedback or testimonial provided may be used by the Company in accordance with the Feedback and Testimonials section of this Agreement, including identifying the testimonial provider by name, designation, company name, brand name, industry and/or company logo where applicable.' },
    ],
  },
];
