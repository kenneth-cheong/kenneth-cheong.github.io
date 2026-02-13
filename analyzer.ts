// GEO Audit Analyzer - Comprehensive Real Website Analysis Engine
// By MediaOne Marketing Singapore

export interface AnalysisResult {
  url: string;
  domain: string;
  timestamp: string;
  overallScore: number;
  categories: CategoryResults;
  recommendations: Recommendation[];
  rawData: RawAnalysisData;
  checks: AuditChecks;
}

export interface CategoryResults {
  [key: string]: {
    score: number;
    criteria: CriterionResult[];
  };
}

export interface CriterionResult {
  id: string;
  name: string;
  description: string;
  weight: number;
  score: number;
  status: 'pass' | 'warning' | 'fail';
  details: string;
}

export interface Recommendation {
  text: string;
  priority: 'high' | 'medium' | 'low';
  category: string;
  impact: string;
}

export interface AuditChecks {
  // Security & Technical
  ssl: CheckResult;
  robotsTxt: CheckResult;
  sitemap: CheckResult;
  canonical: CheckResult;
  hreflang: CheckResult;
  httpRedirect: CheckResult;
  cdnDetected: CheckResult;

  // Meta & SEO
  metaTitle: CheckResult;
  metaDescription: CheckResult;
  structuredData: CheckResult;
  semanticHtml: CheckResult;

  // AI/LLM Readiness
  llmBotBlocked: CheckResult;
  llmsTxt: CheckResult;
  llmsFullTxt: CheckResult;
  aiContentReady: CheckResult;
  jsBlocksAI: CheckResult;

  // Content & Quality
  internalLinking: CheckResult;
  multipleSlashes: CheckResult;
  eeata: CheckResult;

  // Analytics & Tools
  ga4Detected: CheckResult;
  rankMathDetected: CheckResult;
  wordfenceDetected: CheckResult;
}

export interface CheckResult {
  status: 'pass' | 'warning' | 'fail' | 'info';
  message: string;
  details?: string;
  value?: string | number | boolean;
}

export interface RawAnalysisData {
  title: string;
  titleLength: number;
  metaDescription: string;
  metaDescriptionLength: number;
  h1Count: number;
  h2Count: number;
  h3Count: number;
  h4Count: number;
  h5Count: number;
  h6Count: number;
  wordCount: number;
  paragraphCount: number;
  imageCount: number;
  imagesWithAlt: number;
  linkCount: number;
  externalLinks: number;
  internalLinks: number;
  hasSchema: boolean;
  schemaTypes: string[];
  hasFAQSchema: boolean;
  hasHowToSchema: boolean;
  hasArticleSchema: boolean;
  hasOrganizationSchema: boolean;
  hasLocalBusinessSchema: boolean;
  hasBreadcrumbSchema: boolean;
  hasOpenGraph: boolean;
  hasTwitterCard: boolean;
  hasCanonical: boolean;
  canonicalUrl: string;
  hasRobotsMeta: boolean;
  robotsContent: string;
  hasViewport: boolean;
  hasCharset: boolean;
  hasFavicon: boolean;
  hasSSL: boolean;
  hasHreflang: boolean;
  hreflangTags: string[];
  listCount: number;
  tableCount: number;
  formCount: number;
  videoCount: number;
  iframeCount: number;
  codeBlockCount: number;
  blockquoteCount: number;
  hasAuthorInfo: boolean;
  hasDatePublished: boolean;
  hasDateModified: boolean;
  hasBreadcrumbs: boolean;
  hasNavigation: boolean;
  hasFooter: boolean;
  hasHeader: boolean;
  hasMain: boolean;
  hasArticle: boolean;
  hasSection: boolean;
  hasAside: boolean;
  hasSocialLinks: boolean;
  questionCount: number;
  answerPatterns: number;
  bulletPoints: number;
  numberedLists: number;
  readabilityScore: number;
  avgSentenceLength: number;
  avgParagraphLength: number;
  uniqueWords: number;
  contentToHtmlRatio: number;
  loadTime: number;
  hasGA4: boolean;
  hasRankMath: boolean;
  hasWordfence: boolean;
  hasYoast: boolean;
  urlsWithMultipleSlashes: number;
  jsFrameworks: string[];
  hasCDN: boolean;
  cdnProvider: string;
  // Enhanced JS AI Accessibility
  jsRenderingType: 'static' | 'ssr' | 'csr' | 'hybrid';
  hasNoscriptContent: boolean;
  inlineScriptCount: number;
  externalScriptCount: number;
  hasDynamicContent: boolean;
  hasLazyLoading: boolean;
  jsBlockingScore: number;
  jsFrameworkDetails: {
    name: string;
    hasSSR: boolean;
    hasHydration: boolean;
    renderingMethod: string;
  }[];
}

// LLM Bot User Agents to check in robots.txt
const LLM_BOTS = [
  'GPTBot', 'ChatGPT-User', 'CCBot', 'anthropic-ai', 'Claude-Web',
  'Google-Extended', 'Bytespider', 'Amazonbot', 'FacebookBot',
  'PerplexityBot', 'YouBot', 'Applebot-Extended', 'cohere-ai'
];

// CDN Providers to detect
const CDN_SIGNATURES = {
  'cloudflare': ['cf-ray', 'cf-cache-status', '__cfduid', 'cloudflare'],
  'fastly': ['fastly', 'x-served-by', 'x-cache'],
  'akamai': ['akamai', 'x-akamai'],
  'cloudfront': ['cloudfront', 'x-amz-cf'],
  'sucuri': ['sucuri', 'x-sucuri'],
  'stackpath': ['stackpath'],
  'bunny': ['bunnycdn'],
  'keycdn': ['keycdn']
};

// Fetch website with error handling
export async function fetchWebsite(url: string): Promise<{ html: string; loadTime: number; finalUrl: string; headers: Headers }> {
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MediaOneGEOBot/1.0; +https://mediaonemarketing.com.sg)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    const loadTime = Date.now() - startTime;

    return {
      html,
      loadTime,
      finalUrl: response.url,
      headers: response.headers
    };
  } catch (error) {
    throw new Error(`Failed to fetch website: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Fetch robots.txt
async function fetchRobotsTxt(domain: string): Promise<{ content: string | null; exists: boolean; llmBotsBlocked: string[] }> {
  try {
    const response = await fetch(`https://${domain}/robots.txt`, {
      headers: { 'User-Agent': 'MediaOneGEOBot/1.0' }
    });

    if (response.ok) {
      const content = await response.text();
      const blockedBots: string[] = [];

      // Check for LLM bots being blocked
      LLM_BOTS.forEach(bot => {
        const regex = new RegExp(`User-agent:\\s*${bot}[\\s\\S]*?Disallow:\\s*/`, 'i');
        if (regex.test(content)) {
          blockedBots.push(bot);
        }
      });

      // Also check for wildcard blocks that might affect AI bots
      if (/User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*$/m.test(content)) {
        blockedBots.push('All bots (wildcard)');
      }

      return { content, exists: true, llmBotsBlocked: blockedBots };
    }
    return { content: null, exists: false, llmBotsBlocked: [] };
  } catch {
    return { content: null, exists: false, llmBotsBlocked: [] };
  }
}

// Fetch llms.txt - STRICT CHECK
async function fetchLlmsTxt(domain: string): Promise<{ exists: boolean; content: string | null }> {
  try {
    const response = await fetch(`https://${domain}/llms.txt`, {
      headers: { 'User-Agent': 'MediaOneGEOBot/1.0' },
      redirect: 'follow'
    });

    if (response.ok) {
      const content = await response.text();

      // Validation Check: Prevent False Positives from Redirects to HTML pages
      const contentType = response.headers.get('content-type') || '';
      const isHtml = contentType.includes('text/html') ||
        content.trim().toLowerCase().startsWith('<!doctype html') ||
        content.trim().toLowerCase().startsWith('<html');

      const redirectedToRoot = new URL(response.url).pathname === '/';

      if (isHtml || redirectedToRoot) {
        return { exists: false, content: null };
      }

      return { exists: true, content: content.substring(0, 5000) }; // Cap size
    }
    return { exists: false, content: null };
  } catch {
    return { exists: false, content: null };
  }
}

// Fetch llms-full.txt - STRICT CHECK
async function fetchLlmsFullTxt(domain: string): Promise<{ exists: boolean; content: string | null }> {
  try {
    const response = await fetch(`https://${domain}/llms-full.txt`, {
      headers: { 'User-Agent': 'MediaOneGEOBot/1.0' },
      redirect: 'follow'
    });

    if (response.ok) {
      const content = await response.text();

      // Validation Check
      const contentType = response.headers.get('content-type') || '';
      const isHtml = contentType.includes('text/html') ||
        content.trim().toLowerCase().startsWith('<!doctype html') ||
        content.trim().toLowerCase().startsWith('<html');

      const redirectedToRoot = new URL(response.url).pathname === '/';

      if (isHtml || redirectedToRoot) {
        return { exists: false, content: null };
      }

      return { exists: true, content: content.substring(0, 5000) };
    }
    return { exists: false, content: null };
  } catch {
    return { exists: false, content: null };
  }
}

// Fetch sitemap
async function fetchSitemap(domain: string): Promise<{ exists: boolean; url: string | null }> {
  const sitemapUrls = [
    `https://${domain}/sitemap.xml`,
    `https://${domain}/sitemap_index.xml`,
    `https://${domain}/sitemap/sitemap.xml`,
    `https://${domain}/wp-sitemap.xml`
  ];

  for (const url of sitemapUrls) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'MediaOneGEOBot/1.0' }
      });
      if (response.ok) {
        return { exists: true, url };
      }
    } catch {
      continue;
    }
  }
  return { exists: false, url: null };
}

// Detect CDN from headers
function detectCDN(headers: Headers, html: string): { detected: boolean; provider: string } {
  const headerEntries = Array.from(headers.entries());

  for (const [provider, signatures] of Object.entries(CDN_SIGNATURES)) {
    for (const sig of signatures) {
      // Check headers
      for (const [key, value] of headerEntries) {
        if (key.toLowerCase().includes(sig) || value.toLowerCase().includes(sig)) {
          return { detected: true, provider };
        }
      }
      // Check HTML for CDN references
      if (html.toLowerCase().includes(sig)) {
        return { detected: true, provider };
      }
    }
  }

  return { detected: false, provider: '' };
}

// Parse HTML and extract comprehensive analysis data
export function parseHTML(html: string, url: string, headers: Headers): RawAnalysisData {
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = textContent.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;

  // Title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Meta description
  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : '';

  // Heading counts
  const h1Count = (html.match(/<h1[^>]*>/gi) || []).length;
  const h2Count = (html.match(/<h2[^>]*>/gi) || []).length;
  const h3Count = (html.match(/<h3[^>]*>/gi) || []).length;
  const h4Count = (html.match(/<h4[^>]*>/gi) || []).length;
  const h5Count = (html.match(/<h5[^>]*>/gi) || []).length;
  const h6Count = (html.match(/<h6[^>]*>/gi) || []).length;

  // Paragraph count
  const paragraphCount = (html.match(/<p[^>]*>/gi) || []).length;

  // Image analysis
  const images = html.match(/<img[^>]*>/gi) || [];
  const imageCount = images.length;
  const imagesWithAlt = images.filter(img => /alt=["'][^"']+["']/i.test(img)).length;

  // Link analysis
  const links = html.match(/<a[^>]*href=["']([^"']+)["'][^>]*>/gi) || [];
  const linkCount = links.length;

  const urlObj = new URL(url);
  const domain = urlObj.hostname;

  let externalLinks = 0;
  let internalLinks = 0;

  links.forEach(link => {
    const hrefMatch = link.match(/href=["']([^"']+)["']/i);
    if (hrefMatch) {
      const href = hrefMatch[1];
      if (href.startsWith('http') && !href.includes(domain)) {
        externalLinks++;
      } else if (!href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('javascript:') && !href.startsWith('#')) {
        internalLinks++;
      }
    }
  });

  // Schema markup analysis
  const schemaMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const hasSchema = schemaMatches.length > 0;

  const schemaTypes: string[] = [];
  let hasFAQSchema = false;
  let hasHowToSchema = false;
  let hasArticleSchema = false;
  let hasOrganizationSchema = false;
  let hasLocalBusinessSchema = false;
  let hasBreadcrumbSchema = false;

  schemaMatches.forEach(schema => {
    const content = schema.replace(/<[^>]+>/g, '');
    const typeMatches = content.match(/"@type"\s*:\s*"([^"]+)"/g) || [];
    typeMatches.forEach(t => {
      const type = t.match(/"@type"\s*:\s*"([^"]+)"/)?.[1];
      if (type && !schemaTypes.includes(type)) {
        schemaTypes.push(type);
        if (type === 'FAQPage' || type === 'Question') hasFAQSchema = true;
        if (type === 'HowTo') hasHowToSchema = true;
        if (type === 'Article' || type === 'NewsArticle' || type === 'BlogPosting') hasArticleSchema = true;
        if (type === 'Organization') hasOrganizationSchema = true;
        if (type === 'LocalBusiness' || type.includes('Business')) hasLocalBusinessSchema = true;
        if (type === 'BreadcrumbList') hasBreadcrumbSchema = true;
      }
    });
  });

  // Open Graph
  const hasOpenGraph = /<meta[^>]*property=["']og:/i.test(html);

  // Twitter Card
  const hasTwitterCard = /<meta[^>]*name=["']twitter:/i.test(html);

  // Canonical
  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  const hasCanonical = !!canonicalMatch;
  const canonicalUrl = canonicalMatch ? canonicalMatch[1] : '';

  // Robots meta
  const robotsMatch = html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']+)["']/i);
  const hasRobotsMeta = !!robotsMatch;
  const robotsContent = robotsMatch ? robotsMatch[1] : '';

  // Viewport
  const hasViewport = /<meta[^>]*name=["']viewport["']/i.test(html);

  // Charset
  const hasCharset = /<meta[^>]*charset=/i.test(html) || /<meta[^>]*http-equiv=["']Content-Type["']/i.test(html);

  // Favicon
  const hasFavicon = /<link[^>]*rel=["'](icon|shortcut icon|apple-touch-icon)["']/i.test(html);

  // SSL
  const hasSSL = url.startsWith('https://');

  // Hreflang
  const hreflangMatches = html.match(/<link[^>]*hreflang=["']([^"']+)["'][^>]*>/gi) || [];
  const hasHreflang = hreflangMatches.length > 0;
  const hreflangTags = hreflangMatches.map(tag => {
    const match = tag.match(/hreflang=["']([^"']+)["']/i);
    return match ? match[1] : '';
  }).filter(Boolean);

  // Lists
  const listCount = (html.match(/<[uo]l[^>]*>/gi) || []).length;
  const bulletPoints = (html.match(/<li[^>]*>/gi) || []).length;
  const numberedLists = (html.match(/<ol[^>]*>/gi) || []).length;

  // Tables
  const tableCount = (html.match(/<table[^>]*>/gi) || []).length;

  // Forms
  const formCount = (html.match(/<form[^>]*>/gi) || []).length;

  // Videos
  const videoCount = (html.match(/<video[^>]*>/gi) || []).length +
    (html.match(/youtube\.com\/embed/gi) || []).length +
    (html.match(/vimeo\.com/gi) || []).length;

  // Iframes
  const iframeCount = (html.match(/<iframe[^>]*>/gi) || []).length;

  // Code blocks
  const codeBlockCount = (html.match(/<pre[^>]*>/gi) || []).length +
    (html.match(/<code[^>]*>/gi) || []).length;

  // Blockquotes
  const blockquoteCount = (html.match(/<blockquote[^>]*>/gi) || []).length;

  // Semantic HTML elements
  const hasHeader = /<header[^>]*>/i.test(html);
  const hasFooter = /<footer[^>]*>/i.test(html);
  const hasMain = /<main[^>]*>/i.test(html);
  const hasArticle = /<article[^>]*>/i.test(html);
  const hasSection = /<section[^>]*>/i.test(html);
  const hasAside = /<aside[^>]*>/i.test(html);
  const hasNavigation = /<nav[^>]*>/i.test(html);

  // Author info
  const hasAuthorInfo = /author/i.test(html) &&
    (/<[^>]*class=["'][^"']*author[^"']*["']/i.test(html) ||
      /<meta[^>]*name=["']author["']/i.test(html) ||
      /"author"/i.test(html));

  // Date published/modified
  const hasDatePublished = /datePublished/i.test(html) || /<time[^>]*datetime=/i.test(html);
  const hasDateModified = /dateModified/i.test(html);

  // Breadcrumbs
  const hasBreadcrumbs = /breadcrumb/i.test(html);

  // Social links
  const hasSocialLinks = /facebook\.com|twitter\.com|linkedin\.com|instagram\.com|youtube\.com|tiktok\.com/i.test(html);

  // Question patterns
  const questionPatterns = [/what is/gi, /how to/gi, /why does/gi, /when should/gi, /where can/gi, /who is/gi, /which is/gi, /can i/gi, /\?/g];
  let questionCount = 0;
  questionPatterns.forEach(pattern => {
    const matches = textContent.match(pattern);
    if (matches) questionCount += matches.length;
  });

  // Answer patterns
  const answerPatterns = textContent.match(/the answer is|in short|to summarize|in conclusion|the solution|here's how|follow these steps/gi) || [];

  // Readability metrics
  const sentences = textContent.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const avgSentenceLength = sentences.length > 0 ? wordCount / sentences.length : 0;
  const avgParagraphLength = paragraphCount > 0 ? wordCount / paragraphCount : wordCount;

  const complexWords = words.filter(w => w.length > 10).length;
  const readabilityScore = Math.max(0, Math.min(100, 100 - (avgSentenceLength - 15) * 2 - (complexWords / wordCount) * 100));

  // Content to HTML ratio
  const contentToHtmlRatio = (textContent.length / html.length) * 100;

  // Google Analytics 4
  const hasGA4 = /gtag\s*\(\s*['"]config['"]\s*,\s*['"]G-/i.test(html) ||
    /googletagmanager\.com\/gtag/i.test(html) ||
    /GA4/i.test(html);

  // Rank Math SEO
  const hasRankMath = /rank-math/i.test(html) || /rankmath/i.test(html);

  // Wordfence
  const hasWordfence = /wordfence/i.test(html);

  // Yoast SEO
  const hasYoast = /yoast/i.test(html);

  // URLs with multiple slashes
  const urlsWithMultipleSlashes = (html.match(/href=["'][^"']*\/\/[^"']*["']/gi) || [])
    .filter(u => !u.includes('http://') && !u.includes('https://')).length;

  // Enhanced JS Frameworks detection with AI accessibility analysis
  const jsFrameworks: string[] = [];
  const jsFrameworkDetails: { name: string; hasSSR: boolean; hasHydration: boolean; renderingMethod: string; }[] = [];

  // React/Next.js detection
  const hasReact = /react/i.test(html) || /data-reactroot/i.test(html) || /data-reactid/i.test(html);
  const hasNextJs = /__NEXT_DATA__/i.test(html) || /_next\/static/i.test(html);
  if (hasReact || hasNextJs) {
    const isSSR = hasNextJs || (hasReact && wordCount > 100);
    jsFrameworks.push(hasNextJs ? 'Next.js' : 'React');
    jsFrameworkDetails.push({
      name: hasNextJs ? 'Next.js' : 'React',
      hasSSR: isSSR,
      hasHydration: hasReact,
      renderingMethod: hasNextJs ? 'SSR/SSG' : (isSSR ? 'SSR' : 'CSR')
    });
  }

  // Vue/Nuxt detection
  const hasVue = /vue/i.test(html) || /__VUE__/i.test(html) || /data-v-/i.test(html);
  const hasNuxt = /__NUXT__/i.test(html) || /nuxt/i.test(html);
  if (hasVue || hasNuxt) {
    const isSSR = hasNuxt || (hasVue && wordCount > 100);
    jsFrameworks.push(hasNuxt ? 'Nuxt' : 'Vue.js');
    jsFrameworkDetails.push({
      name: hasNuxt ? 'Nuxt' : 'Vue.js',
      hasSSR: isSSR,
      hasHydration: hasVue,
      renderingMethod: hasNuxt ? 'SSR/SSG' : (isSSR ? 'SSR' : 'CSR')
    });
  }

  // Angular detection
  const hasAngular = /angular/i.test(html) || /ng-version/i.test(html) || /ng-app/i.test(html);
  if (hasAngular) {
    const isUniversal = /ng-state/i.test(html) || /serverApp/i.test(html);
    jsFrameworks.push('Angular');
    jsFrameworkDetails.push({
      name: 'Angular',
      hasSSR: isUniversal,
      hasHydration: true,
      renderingMethod: isUniversal ? 'Angular Universal (SSR)' : 'CSR'
    });
  }

  // Gatsby detection (always SSG)
  if (/gatsby/i.test(html) || /___gatsby/i.test(html)) {
    jsFrameworks.push('Gatsby');
    jsFrameworkDetails.push({
      name: 'Gatsby',
      hasSSR: true,
      hasHydration: true,
      renderingMethod: 'SSG (Static)'
    });
  }

  // Svelte/SvelteKit detection
  if (/svelte/i.test(html) || /__SVELTEKIT/i.test(html)) {
    const isSvelteKit = /__SVELTEKIT/i.test(html);
    jsFrameworks.push(isSvelteKit ? 'SvelteKit' : 'Svelte');
    jsFrameworkDetails.push({
      name: isSvelteKit ? 'SvelteKit' : 'Svelte',
      hasSSR: isSvelteKit,
      hasHydration: true,
      renderingMethod: isSvelteKit ? 'SSR/SSG' : 'CSR'
    });
  }

  // Additional framework detection
  if (/astro/i.test(html)) {
    jsFrameworks.push('Astro');
    jsFrameworkDetails.push({ name: 'Astro', hasSSR: true, hasHydration: false, renderingMethod: 'SSG (Static)' });
  }
  if (/remix/i.test(html)) {
    jsFrameworks.push('Remix');
    jsFrameworkDetails.push({ name: 'Remix', hasSSR: true, hasHydration: true, renderingMethod: 'SSR' });
  }

  // Determine JS rendering type
  let jsRenderingType: 'static' | 'ssr' | 'csr' | 'hybrid' = 'static';
  if (jsFrameworks.length > 0) {
    const hasAnySSR = jsFrameworkDetails.some(f => f.hasSSR);
    const hasAnyCSR = jsFrameworkDetails.some(f => !f.hasSSR);
    if (hasAnySSR && hasAnyCSR) {
      jsRenderingType = 'hybrid';
    } else if (hasAnySSR) {
      jsRenderingType = 'ssr';
    } else {
      jsRenderingType = 'csr';
    }
  }

  // Check for noscript content
  const noscriptMatches = html.match(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi) || [];
  const hasNoscriptContent = noscriptMatches.some(ns => {
    const content = ns.replace(/<[^>]+>/g, '').trim();
    return content.length > 50; // Meaningful noscript content
  });

  // Count scripts
  const inlineScriptCount = (html.match(/<script[^>]*>(?!\s*<\/script>)[\s\S]*?<\/script>/gi) || []).length;
  const externalScriptCount = (html.match(/<script[^>]*src=["'][^"']+["'][^>]*>/gi) || []).length;

  // Detect dynamic content indicators
  const hasDynamicContent = /data-loading|skeleton|placeholder|lazy/i.test(html) ||
    /\{\{.*\}\}|\{%.*%\}/i.test(html) ||
    /v-if|v-for|ng-repeat|\*ngFor/i.test(html);

  // Lazy loading detection
  const hasLazyLoading = /loading=["']lazy["']|data-src|lazyload/i.test(html);

  // Calculate JS blocking score (0 = fully accessible, 100 = completely blocked)
  let jsBlockingScore = 0;
  if (jsFrameworks.length > 0) {
    // Base penalty for using JS frameworks
    jsBlockingScore += 20;

    // CSR penalty
    if (jsRenderingType === 'csr') jsBlockingScore += 40;
    else if (jsRenderingType === 'hybrid') jsBlockingScore += 15;

    // Low content ratio indicates JS-dependent content
    if (contentToHtmlRatio < 10) jsBlockingScore += 25;
    else if (contentToHtmlRatio < 20) jsBlockingScore += 10;

    // No noscript fallback
    if (!hasNoscriptContent) jsBlockingScore += 10;

    // Heavy script usage
    if (externalScriptCount > 15) jsBlockingScore += 10;
    else if (externalScriptCount > 10) jsBlockingScore += 5;
  }
  jsBlockingScore = Math.min(100, jsBlockingScore);

  // CDN detection
  const cdn = detectCDN(headers, html);

  return {
    title,
    titleLength: title.length,
    metaDescription,
    metaDescriptionLength: metaDescription.length,
    h1Count,
    h2Count,
    h3Count,
    h4Count,
    h5Count,
    h6Count,
    wordCount,
    paragraphCount,
    imageCount,
    imagesWithAlt,
    linkCount,
    externalLinks,
    internalLinks,
    hasSchema,
    schemaTypes,
    hasFAQSchema,
    hasHowToSchema,
    hasArticleSchema,
    hasOrganizationSchema,
    hasLocalBusinessSchema,
    hasBreadcrumbSchema,
    hasOpenGraph,
    hasTwitterCard,
    hasCanonical,
    canonicalUrl,
    hasRobotsMeta,
    robotsContent,
    hasViewport,
    hasCharset,
    hasFavicon,
    hasSSL,
    hasHreflang,
    hreflangTags,
    listCount,
    tableCount,
    formCount,
    videoCount,
    iframeCount,
    codeBlockCount,
    blockquoteCount,
    hasAuthorInfo,
    hasDatePublished,
    hasDateModified,
    hasBreadcrumbs,
    hasNavigation,
    hasFooter,
    hasHeader,
    hasMain,
    hasArticle,
    hasSection,
    hasAside,
    hasSocialLinks,
    questionCount,
    answerPatterns: answerPatterns.length,
    bulletPoints,
    numberedLists,
    readabilityScore,
    avgSentenceLength,
    avgParagraphLength,
    uniqueWords,
    contentToHtmlRatio,
    loadTime: 0,
    hasGA4,
    hasRankMath,
    hasWordfence,
    hasYoast,
    urlsWithMultipleSlashes,
    jsFrameworks,
    hasCDN: cdn.detected,
    cdnProvider: cdn.provider,
    // Enhanced JS AI Accessibility
    jsRenderingType,
    hasNoscriptContent,
    inlineScriptCount,
    externalScriptCount,
    hasDynamicContent,
    hasLazyLoading,
    jsBlockingScore,
    jsFrameworkDetails
  };
}

// Generate detailed JS accessibility message - ENHANCED FOR GEO
function generateJsAccessibilityMessage(data: RawAnalysisData): string {
  if (data.jsFrameworks.length === 0) {
    return '✅ No JavaScript frameworks detected - content is fully accessible to AI crawlers (GPTBot, ClaudeBot, PerplexityBot)';
  }

  const frameworks = data.jsFrameworks.join(', ');
  const renderingType = data.jsRenderingType.toUpperCase();
  const accessibilityScore = 100 - data.jsBlockingScore;

  if (data.jsBlockingScore <= 10) {
    return `✅ ${frameworks} with ${renderingType} - Excellent AI accessibility (${accessibilityScore}/100)`;
  } else if (data.jsBlockingScore <= 25) {
    return `✅ ${frameworks} (${renderingType}) - Good AI accessibility (${accessibilityScore}/100)`;
  } else if (data.jsBlockingScore <= 45) {
    return `⚠️ ${frameworks} (${renderingType}) - Partial AI accessibility (${accessibilityScore}/100) - Optimization needed`;
  } else if (data.jsBlockingScore <= 65) {
    return `❌ ${frameworks} (${renderingType}) - Poor AI accessibility (${accessibilityScore}/100) - AI crawlers may miss content`;
  } else {
    return `🚨 ${frameworks} (${renderingType}) - Critical: AI crawlers likely see blank page (${accessibilityScore}/100)`;
  }
}

// Generate detailed JS accessibility details - COMPREHENSIVE GEO ANALYSIS
function generateJsAccessibilityDetails(data: RawAnalysisData): string {
  const details: string[] = [];

  if (data.jsFrameworks.length === 0) {
    details.push('✅ OPTIMAL: Static HTML content - fully accessible to GPTBot, ClaudeBot, PerplexityBot');
    details.push(`✅ Content-to-HTML ratio: ${Math.round(data.contentToHtmlRatio)}% (AI can read all content)`);
    details.push('✅ No JavaScript execution required');
    return details.join(' || ');
  }

  // Rendering analysis - CRITICAL FOR GEO
  details.push('🔍 RENDERING ANALYSIS:');
  if (data.jsRenderingType === 'static') {
    details.push('✅ Static/Pre-rendered - AI crawlers see full content');
  } else if (data.jsRenderingType === 'ssr') {
    details.push('✅ Server-Side Rendered (SSR) - Content available in initial HTML');
  } else if (data.jsRenderingType === 'csr') {
    details.push('🚨 CLIENT-SIDE RENDERED (CSR) - CRITICAL: AI crawlers see blank/minimal content!');
  } else {
    details.push('⚠️ Hybrid rendering - Some content may be invisible to AI');
  }

  // Framework-specific analysis
  details.push('');
  details.push('🛠️ FRAMEWORK ANALYSIS:');
  data.jsFrameworkDetails.forEach(f => {
    if (f.hasSSR) {
      details.push(`✅ ${f.name}: ${f.renderingMethod} - GEO Friendly`);
    } else {
      details.push(`❌ ${f.name}: ${f.renderingMethod} - GEO PROBLEM: Not accessible to AI crawlers`);
    }
  });

  // Noscript fallback - IMPORTANT FOR GEO
  details.push('');
  details.push('📝 FALLBACK CONTENT:');
  if (data.hasNoscriptContent) {
    details.push('✅ Noscript fallback present - AI has alternative content');
  } else if (data.jsFrameworks.length > 0) {
    details.push('❌ NO noscript fallback - AI crawlers see nothing if JS fails');
  }

  // Content ratio - KEY GEO METRIC
  details.push('');
  details.push('📊 CONTENT VISIBILITY:');
  if (data.contentToHtmlRatio >= 25) {
    details.push(`✅ Excellent content ratio: ${Math.round(data.contentToHtmlRatio)}% - Most content visible without JS`);
  } else if (data.contentToHtmlRatio >= 15) {
    details.push(`✅ Good content ratio: ${Math.round(data.contentToHtmlRatio)}%`);
  } else if (data.contentToHtmlRatio >= 8) {
    details.push(`⚠️ Low content ratio: ${Math.round(data.contentToHtmlRatio)}% - Much content requires JS`);
  } else {
    details.push(`🚨 CRITICAL: Very low content ratio: ${Math.round(data.contentToHtmlRatio)}% - Almost all content requires JS execution`);
  }

  // Script analysis
  details.push('');
  details.push('💻 SCRIPT LOAD:');
  if (data.externalScriptCount <= 5 && data.inlineScriptCount <= 3) {
    details.push(`✅ Light script load: ${data.externalScriptCount} external, ${data.inlineScriptCount} inline`);
  } else if (data.externalScriptCount <= 12) {
    details.push(`⚠️ Moderate script load: ${data.externalScriptCount} external, ${data.inlineScriptCount} inline`);
  } else {
    details.push(`❌ Heavy script load: ${data.externalScriptCount} external, ${data.inlineScriptCount} inline - May slow AI crawling`);
  }

  // Dynamic content warnings
  if (data.hasDynamicContent) {
    details.push('');
    details.push('⚠️ Dynamic content indicators detected - Some content loaded via JavaScript');
  }

  if (data.hasLazyLoading) {
    details.push('⚠️ Lazy loading detected - Below-fold content may not be indexed by AI');
  }

  return details.join(' || ');
}

// Generate audit checks
function generateAuditChecks(
  data: RawAnalysisData,
  robotsTxt: { content: string | null; exists: boolean; llmBotsBlocked: string[] },
  sitemap: { exists: boolean; url: string | null },
  llmsTxt: { exists: boolean; content: string | null },
  llmsFullTxt: { exists: boolean; content: string | null }
): AuditChecks {
  return {
    // SSL Certificate
    ssl: {
      status: data.hasSSL ? 'pass' : 'fail',
      message: data.hasSSL ? 'SSL Certificate is active (HTTPS)' : 'No SSL Certificate detected',
      details: data.hasSSL ? 'Site is secure with HTTPS' : 'Site is using HTTP - security risk'
    },

    // robots.txt
    robotsTxt: {
      status: robotsTxt.exists ? 'pass' : 'fail',
      message: robotsTxt.exists ? 'robots.txt file found' : 'robots.txt file not found',
      details: robotsTxt.exists ? 'Robots.txt is properly configured' : 'Create a robots.txt file to control crawler access'
    },

    // Sitemap
    sitemap: {
      status: sitemap.exists ? 'pass' : 'fail',
      message: sitemap.exists ? `Sitemap found: ${sitemap.url}` : 'No sitemap found',
      details: sitemap.exists ? 'XML sitemap helps search engines discover content' : 'Create an XML sitemap for better indexing'
    },

    // Canonical Tag
    canonical: {
      status: data.hasCanonical ? 'pass' : 'warning',
      message: data.hasCanonical ? `Canonical tag present: ${data.canonicalUrl}` : 'No canonical tag found',
      details: data.hasCanonical ? 'Canonical URL helps prevent duplicate content issues' : 'Add canonical tags to prevent duplicate content'
    },

    // Hreflang
    hreflang: {
      status: data.hasHreflang ? 'pass' : 'info',
      message: data.hasHreflang ? `Hreflang tags found: ${data.hreflangTags.join(', ')}` : 'No hreflang tags detected',
      details: data.hasHreflang ? 'Multi-language/region targeting is configured' : 'Add hreflang tags if targeting multiple countries/languages (e.g., en-sg)',
      value: data.hreflangTags.join(', ')
    },

    // HTTP to HTTPS Redirect
    httpRedirect: {
      status: data.hasSSL ? 'pass' : 'fail',
      message: data.hasSSL ? 'HTTPS is enabled' : 'HTTP to HTTPS redirect needed',
      details: 'Ensure all HTTP requests redirect to HTTPS'
    },

    // CDN
    cdnDetected: {
      status: data.hasCDN ? 'pass' : 'warning',
      message: data.hasCDN ? `CDN detected: ${data.cdnProvider}` : 'No CDN detected',
      details: data.hasCDN ? 'Content Delivery Network improves load times' : 'Consider using a CDN for better performance'
    },

    // Meta Title
    metaTitle: {
      status: data.titleLength >= 30 && data.titleLength <= 60 ? 'pass' : data.titleLength > 0 ? 'warning' : 'fail',
      message: data.titleLength > 0 ? `Title: "${data.title.substring(0, 50)}${data.title.length > 50 ? '...' : ''}" (${data.titleLength} chars)` : 'No meta title found',
      details: data.titleLength >= 30 && data.titleLength <= 60 ? 'Title length is optimal (30-60 chars)' :
        data.titleLength < 30 ? 'Title is too short (aim for 30-60 chars)' :
          data.titleLength > 60 ? 'Title is too long (aim for 30-60 chars)' : 'Add a meta title',
      value: data.titleLength
    },

    // Meta Description
    metaDescription: {
      status: data.metaDescriptionLength >= 120 && data.metaDescriptionLength <= 160 ? 'pass' : data.metaDescriptionLength > 0 ? 'warning' : 'fail',
      message: data.metaDescriptionLength > 0 ? `Description: ${data.metaDescriptionLength} chars` : 'No meta description found',
      details: data.metaDescriptionLength >= 120 && data.metaDescriptionLength <= 160 ? 'Description length is optimal (120-160 chars)' :
        data.metaDescriptionLength < 120 ? 'Description is too short (aim for 120-160 chars)' :
          data.metaDescriptionLength > 160 ? 'Description is too long (aim for 120-160 chars)' : 'Add a meta description',
      value: data.metaDescriptionLength
    },

    // Structured Data
    structuredData: {
      status: data.hasSchema ? 'pass' : 'fail',
      message: data.hasSchema ? `Structured data found: ${data.schemaTypes.join(', ')}` : 'No structured data markup found',
      details: data.hasSchema ? 'JSON-LD structured data helps AI understand content' : 'Add Schema.org markup (FAQ, Article, Organization, etc.)'
    },

    // Semantic HTML
    semanticHtml: {
      status: (data.hasHeader && data.hasMain && data.hasFooter) ? 'pass' :
        (data.hasHeader || data.hasMain || data.hasFooter || data.hasArticle || data.hasSection) ? 'warning' : 'fail',
      message: `Semantic elements: ${[
        data.hasHeader ? 'header' : '',
        data.hasMain ? 'main' : '',
        data.hasFooter ? 'footer' : '',
        data.hasArticle ? 'article' : '',
        data.hasSection ? 'section' : '',
        data.hasNavigation ? 'nav' : '',
        data.hasAside ? 'aside' : ''
      ].filter(Boolean).join(', ') || 'None found'}`,
      details: 'Semantic HTML helps AI understand page structure'
    },

    // LLM Bots Blocked
    llmBotBlocked: {
      status: robotsTxt.llmBotsBlocked.length === 0 ? 'pass' : 'warning',
      message: robotsTxt.llmBotsBlocked.length === 0 ? 'No LLM bots are blocked' : `LLM bots blocked: ${robotsTxt.llmBotsBlocked.join(', ')}`,
      details: robotsTxt.llmBotsBlocked.length === 0 ? 'AI crawlers can access your content' : 'Consider allowing AI bots for GEO visibility'
    },

    // llms.txt
    llmsTxt: {
      status: llmsTxt.exists ? 'pass' : 'info',
      message: llmsTxt.exists ? 'llms.txt file found' : 'No llms.txt file found',
      details: llmsTxt.exists ? 'LLM-specific instructions are provided' : 'Consider adding llms.txt for AI crawler guidance'
    },

    // llms-full.txt
    llmsFullTxt: {
      status: llmsFullTxt.exists ? 'pass' : 'info',
      message: llmsFullTxt.exists ? 'llms-full.txt file found' : 'No llms-full.txt file found',
      details: llmsFullTxt.exists ? 'Full LLM context is available' : 'Consider adding llms-full.txt for comprehensive AI context'
    },

    // AI Content Ready (E-E-A-T-A)
    aiContentReady: {
      status: (data.hasAuthorInfo && data.hasDatePublished && data.wordCount >= 500) ? 'pass' :
        (data.hasAuthorInfo || data.hasDatePublished || data.wordCount >= 300) ? 'warning' : 'fail',
      message: `E-E-A-T-A signals: Author: ${data.hasAuthorInfo ? '✓' : '✗'}, Date: ${data.hasDatePublished ? '✓' : '✗'}, Content depth: ${data.wordCount} words`,
      details: 'Experience, Expertise, Authoritativeness, Trustworthiness, AI-readiness'
    },

    // JS Blocks AI Crawl - ULTRA-STRICT GEO Check
    jsBlocksAI: {
      status: data.jsBlockingScore <= 10 ? 'pass' :
        data.jsBlockingScore <= 30 ? 'warning' : 'fail',
      message: generateJsAccessibilityMessage(data),
      details: generateJsAccessibilityDetails(data),
      value: data.jsBlockingScore
    },

    // Internal Linking
    internalLinking: {
      status: data.internalLinks >= 10 ? 'pass' : data.internalLinks >= 3 ? 'warning' : 'fail',
      message: `${data.internalLinks} internal links found`,
      details: data.internalLinks >= 10 ? 'Good internal linking structure' : 'Add more internal links to improve site structure',
      value: data.internalLinks
    },

    // Multiple Slashes in URL
    multipleSlashes: {
      status: data.urlsWithMultipleSlashes === 0 ? 'pass' : 'warning',
      message: data.urlsWithMultipleSlashes === 0 ? 'No URLs with multiple slashes' : `${data.urlsWithMultipleSlashes} URLs with multiple slashes found`,
      details: 'Multiple slashes in URLs can cause crawling issues'
    },

    // E-E-A-T-A (comprehensive)
    eeata: {
      status: calculateEEATAScore(data) >= 70 ? 'pass' : calculateEEATAScore(data) >= 40 ? 'warning' : 'fail',
      message: `E-E-A-T-A Score: ${calculateEEATAScore(data)}/100`,
      details: 'Experience, Expertise, Authoritativeness, Trustworthiness, AI-driven content',
      value: calculateEEATAScore(data)
    },

    // Google Analytics 4
    ga4Detected: {
      status: data.hasGA4 ? 'pass' : 'warning',
      message: data.hasGA4 ? 'Google Analytics 4 detected' : 'Google Analytics 4 not detected',
      details: data.hasGA4 ? 'GA4 is properly installed' : 'Consider installing Google Analytics 4 for tracking'
    },

    // Rank Math
    rankMathDetected: {
      status: data.hasRankMath ? 'pass' : 'info',
      message: data.hasRankMath ? 'Rank Math SEO detected' : 'Rank Math SEO not detected',
      details: data.hasRankMath ? 'Rank Math is installed' : 'Consider installing Rank Math for better SEO management'
    },

    // Wordfence
    wordfenceDetected: {
      status: data.hasWordfence ? 'pass' : 'info',
      message: data.hasWordfence ? 'Wordfence Security detected' : 'Wordfence Security not detected',
      details: data.hasWordfence ? 'Wordfence is protecting your site' : 'Consider installing Wordfence for security'
    }
  };
}

// Calculate E-E-A-T-A Score
function calculateEEATAScore(data: RawAnalysisData): number {
  let score = 0;

  // Experience (20 points)
  if (data.hasAuthorInfo) score += 10;
  if (data.hasDatePublished) score += 5;
  if (data.hasDateModified) score += 5;

  // Expertise (20 points)
  if (data.wordCount >= 1000) score += 10;
  else if (data.wordCount >= 500) score += 5;
  if (data.h2Count >= 3) score += 5;
  if (data.externalLinks >= 3) score += 5;

  // Authoritativeness (20 points)
  if (data.hasSchema) score += 10;
  if (data.hasOrganizationSchema || data.hasLocalBusinessSchema) score += 5;
  if (data.hasBreadcrumbSchema) score += 5;

  // Trustworthiness (20 points)
  if (data.hasSSL) score += 10;
  if (data.hasCanonical) score += 5;
  if (data.hasSocialLinks) score += 5;

  // AI-driven content (20 points)
  if (data.hasFAQSchema) score += 5;
  if (data.hasHowToSchema) score += 5;
  if (data.questionCount >= 5) score += 5;
  if (data.listCount >= 2) score += 5;

  return score;
}

// Calculate category scores
export function calculateScores(data: RawAnalysisData, checks: AuditChecks): CategoryResults {
  const categories: CategoryResults = {
    technical_seo: { score: 0, criteria: [] },
    content_quality: { score: 0, criteria: [] },
    ai_readiness: { score: 0, criteria: [] },
    security_trust: { score: 0, criteria: [] },
    user_experience: { score: 0, criteria: [] }
  };

  // Technical SEO
  categories.technical_seo.criteria = [
    {
      id: 'ssl',
      name: 'SSL Certificate',
      description: checks.ssl.details || '',
      weight: 15,
      score: checks.ssl.status === 'pass' ? 100 : 0,
      status: checks.ssl.status as 'pass' | 'warning' | 'fail',
      details: checks.ssl.message
    },
    {
      id: 'robots_txt',
      name: 'robots.txt',
      description: checks.robotsTxt.details || '',
      weight: 10,
      score: checks.robotsTxt.status === 'pass' ? 100 : 0,
      status: checks.robotsTxt.status as 'pass' | 'warning' | 'fail',
      details: checks.robotsTxt.message
    },
    {
      id: 'sitemap',
      name: 'XML Sitemap',
      description: checks.sitemap.details || '',
      weight: 10,
      score: checks.sitemap.status === 'pass' ? 100 : 0,
      status: checks.sitemap.status as 'pass' | 'warning' | 'fail',
      details: checks.sitemap.message
    },
    {
      id: 'canonical',
      name: 'Canonical Tag',
      description: checks.canonical.details || '',
      weight: 12,
      score: checks.canonical.status === 'pass' ? 100 : checks.canonical.status === 'warning' ? 30 : 0,
      status: checks.canonical.status as 'pass' | 'warning' | 'fail',
      details: checks.canonical.message
    },
    {
      id: 'meta_title',
      name: 'Meta Title Optimization',
      description: checks.metaTitle.details || '',
      weight: 12,
      score: checks.metaTitle.status === 'pass' ? 100 : checks.metaTitle.status === 'warning' ? 40 : 0,
      status: checks.metaTitle.status as 'pass' | 'warning' | 'fail',
      details: checks.metaTitle.message
    },
    {
      id: 'meta_description',
      name: 'Meta Description Optimization',
      description: checks.metaDescription.details || '',
      weight: 12,
      score: checks.metaDescription.status === 'pass' ? 100 : checks.metaDescription.status === 'warning' ? 40 : 0,
      status: checks.metaDescription.status as 'pass' | 'warning' | 'fail',
      details: checks.metaDescription.message
    },
    {
      id: 'hreflang',
      name: 'Hreflang Tags',
      description: checks.hreflang.details || '',
      weight: 8,
      score: checks.hreflang.status === 'pass' ? 100 : checks.hreflang.status === 'info' ? 30 : 0,
      status: checks.hreflang.status === 'info' ? 'warning' : checks.hreflang.status as 'pass' | 'warning' | 'fail',
      details: checks.hreflang.message
    },
    {
      id: 'cdn',
      name: 'Content Delivery Network',
      description: checks.cdnDetected.details || '',
      weight: 8,
      score: checks.cdnDetected.status === 'pass' ? 100 : 20,
      status: checks.cdnDetected.status as 'pass' | 'warning' | 'fail',
      details: checks.cdnDetected.message
    },
    {
      id: 'multiple_slashes',
      name: 'URL Structure (Multiple Slashes)',
      description: checks.multipleSlashes.details || '',
      weight: 5,
      score: checks.multipleSlashes.status === 'pass' ? 100 : 50,
      status: checks.multipleSlashes.status as 'pass' | 'warning' | 'fail',
      details: checks.multipleSlashes.message
    }
  ];

  // Content Quality
  categories.content_quality.criteria = [
    {
      id: 'structured_data',
      name: 'Structured Data Markup',
      description: checks.structuredData.details || '',
      weight: 18,
      score: checks.structuredData.status === 'pass' ? 100 : 0,
      status: checks.structuredData.status as 'pass' | 'warning' | 'fail',
      details: checks.structuredData.message
    },
    {
      id: 'semantic_html',
      name: 'Semantic HTML',
      description: checks.semanticHtml.details || '',
      weight: 15,
      score: checks.semanticHtml.status === 'pass' ? 100 : checks.semanticHtml.status === 'warning' ? 40 : 10,
      status: checks.semanticHtml.status as 'pass' | 'warning' | 'fail',
      details: checks.semanticHtml.message
    },
    {
      id: 'content_depth',
      name: 'Content Depth',
      description: `${data.wordCount} words, ${data.h2Count} H2 headings, ${data.paragraphCount} paragraphs`,
      weight: 15,
      score: data.wordCount >= 2000 ? 100 : data.wordCount >= 1500 ? 80 : data.wordCount >= 1000 ? 60 : data.wordCount >= 500 ? 40 : data.wordCount >= 300 ? 20 : 5,
      status: data.wordCount >= 1000 ? 'pass' : data.wordCount >= 500 ? 'warning' : 'fail',
      details: `Word count: ${data.wordCount}, Headings: H1(${data.h1Count}) H2(${data.h2Count}) H3(${data.h3Count})`
    },
    {
      id: 'internal_linking',
      name: 'Internal Linking',
      description: checks.internalLinking.details || '',
      weight: 12,
      score: checks.internalLinking.status === 'pass' ? 100 : checks.internalLinking.status === 'warning' ? 50 : 20,
      status: checks.internalLinking.status as 'pass' | 'warning' | 'fail',
      details: checks.internalLinking.message
    },
    {
      id: 'eeata',
      name: 'E-E-A-T-A Signals',
      description: checks.eeata.details || '',
      weight: 20,
      score: checks.eeata.value as number || 0,
      status: checks.eeata.status as 'pass' | 'warning' | 'fail',
      details: checks.eeata.message
    },
    {
      id: 'images',
      name: 'Image Optimization',
      description: `${data.imagesWithAlt}/${data.imageCount} images have alt text`,
      weight: 10,
      score: data.imageCount === 0 ? 50 : Math.round((data.imagesWithAlt / data.imageCount) * 100),
      status: data.imageCount === 0 ? 'warning' : (data.imagesWithAlt / data.imageCount) >= 0.8 ? 'pass' : 'warning',
      details: `${data.imagesWithAlt} of ${data.imageCount} images have alt attributes`
    }
  ];

  // AI Readiness - ULTRA-STRICT SCORING FOR GEO/AISEO
  categories.ai_readiness.criteria = [
    {
      id: 'llm_bots',
      name: 'LLM Bot Access',
      description: checks.llmBotBlocked.details || '',
      weight: 20,
      score: checks.llmBotBlocked.status === 'pass' ? 100 : 0, // ULTRA-STRICT: blocking LLM bots is automatic failure
      status: checks.llmBotBlocked.status as 'pass' | 'warning' | 'fail',
      details: checks.llmBotBlocked.message
    },
    {
      id: 'llms_txt',
      name: 'llms.txt File',
      description: checks.llmsTxt.details || '',
      weight: 20,
      score: checks.llmsTxt.status === 'pass' ? 100 : 0, // ULTRA-STRICT: llms.txt is essential for GEO
      status: checks.llmsTxt.status === 'info' ? 'fail' : checks.llmsTxt.status as 'pass' | 'warning' | 'fail',
      details: checks.llmsTxt.message
    },
    {
      id: 'llms_full_txt',
      name: 'llms-full.txt File',
      description: checks.llmsFullTxt.details || '',
      weight: 15,
      score: checks.llmsFullTxt.status === 'pass' ? 100 : 0, // ULTRA-STRICT: important for comprehensive AI context
      status: checks.llmsFullTxt.status === 'info' ? 'fail' : checks.llmsFullTxt.status as 'pass' | 'warning' | 'fail',
      details: checks.llmsFullTxt.message
    },
    {
      id: 'js_blocks_ai',
      name: 'JavaScript AI Accessibility',
      description: checks.jsBlocksAI.details || '',
      weight: 20,
      score: checks.jsBlocksAI.status === 'pass' ? 100 : checks.jsBlocksAI.status === 'warning' ? 30 : 0, // ULTRA-STRICT: JS blocking is critical failure
      status: checks.jsBlocksAI.status as 'pass' | 'warning' | 'fail',
      details: checks.jsBlocksAI.message
    },
    {
      id: 'faq_schema',
      name: 'FAQ Schema for AI',
      description: data.hasFAQSchema ? 'FAQ schema helps AI understand Q&A content' : 'No FAQ schema found',
      weight: 10,
      score: data.hasFAQSchema ? 100 : 0, // STRICT: FAQ schema is important for GEO
      status: data.hasFAQSchema ? 'pass' : 'fail',
      details: data.hasFAQSchema ? 'FAQ structured data is present' : 'Add FAQ schema for better AI visibility'
    },
    {
      id: 'ai_content',
      name: 'AI-Driven Content Structure',
      description: checks.aiContentReady.details || '',
      weight: 15,
      score: checks.aiContentReady.status === 'pass' ? 100 : checks.aiContentReady.status === 'warning' ? 25 : 0, // ULTRA-STRICT
      status: checks.aiContentReady.status as 'pass' | 'warning' | 'fail',
      details: checks.aiContentReady.message
    }
  ];

  // Security & Trust
  categories.security_trust.criteria = [
    {
      id: 'ssl_security',
      name: 'SSL/HTTPS Security',
      description: 'Secure connection protects user data',
      weight: 25,
      score: data.hasSSL ? 100 : 0,
      status: data.hasSSL ? 'pass' : 'fail',
      details: data.hasSSL ? 'Site is secured with HTTPS' : 'Enable HTTPS for security'
    },
    {
      id: 'wordfence',
      name: 'Wordfence Security',
      description: checks.wordfenceDetected.details || '',
      weight: 15,
      score: checks.wordfenceDetected.status === 'pass' ? 100 : 40,
      status: checks.wordfenceDetected.status === 'info' ? 'warning' : checks.wordfenceDetected.status as 'pass' | 'warning' | 'fail',
      details: checks.wordfenceDetected.message
    },
    {
      id: 'http_redirect',
      name: 'HTTP to HTTPS Redirect',
      description: 'All HTTP traffic should redirect to HTTPS',
      weight: 20,
      score: data.hasSSL ? 80 : 0,
      status: data.hasSSL ? 'pass' : 'fail',
      details: data.hasSSL ? 'HTTPS is enabled' : 'Enable HTTPS and redirect HTTP traffic'
    },
    {
      id: 'trust_signals',
      name: 'Trust Signals',
      description: 'Social links, author info, and dates build trust',
      weight: 20,
      score: ((data.hasSocialLinks ? 33 : 0) + (data.hasAuthorInfo ? 33 : 0) + (data.hasDatePublished ? 34 : 0)),
      status: (data.hasSocialLinks && data.hasAuthorInfo) ? 'pass' : (data.hasSocialLinks || data.hasAuthorInfo) ? 'warning' : 'fail',
      details: `Social: ${data.hasSocialLinks ? '✓' : '✗'}, Author: ${data.hasAuthorInfo ? '✓' : '✗'}, Date: ${data.hasDatePublished ? '✓' : '✗'}`
    },
    {
      id: 'ga4',
      name: 'Google Analytics 4',
      description: checks.ga4Detected.details || '',
      weight: 10,
      score: checks.ga4Detected.status === 'pass' ? 100 : 40,
      status: checks.ga4Detected.status as 'pass' | 'warning' | 'fail',
      details: checks.ga4Detected.message
    },
    {
      id: 'rank_math',
      name: 'Rank Math SEO Plugin',
      description: checks.rankMathDetected.details || '',
      weight: 10,
      score: checks.rankMathDetected.status === 'pass' ? 100 : 40,
      status: checks.rankMathDetected.status === 'info' ? 'warning' : checks.rankMathDetected.status as 'pass' | 'warning' | 'fail',
      details: checks.rankMathDetected.message
    }
  ];

  // User Experience
  categories.user_experience.criteria = [
    {
      id: 'mobile_viewport',
      name: 'Mobile Viewport',
      description: 'Viewport meta tag for responsive design',
      weight: 20,
      score: data.hasViewport ? 100 : 0,
      status: data.hasViewport ? 'pass' : 'fail',
      details: data.hasViewport ? 'Mobile viewport is configured' : 'Add viewport meta tag for mobile'
    },
    {
      id: 'navigation',
      name: 'Site Navigation',
      description: 'Clear navigation structure',
      weight: 15,
      score: (data.hasNavigation ? 50 : 0) + (data.hasBreadcrumbs ? 50 : 0),
      status: data.hasNavigation ? 'pass' : 'warning',
      details: `Navigation: ${data.hasNavigation ? '✓' : '✗'}, Breadcrumbs: ${data.hasBreadcrumbs ? '✓' : '✗'}`
    },
    {
      id: 'readability',
      name: 'Content Readability',
      description: 'Easy to read content structure',
      weight: 20,
      score: Math.round(data.readabilityScore),
      status: data.readabilityScore >= 70 ? 'pass' : data.readabilityScore >= 50 ? 'warning' : 'fail',
      details: `Readability score: ${Math.round(data.readabilityScore)}/100`
    },
    {
      id: 'page_structure',
      name: 'Page Structure',
      description: 'Proper heading hierarchy and content organization',
      weight: 15,
      score: (data.h1Count === 1 ? 40 : 0) + (data.h2Count >= 2 ? 30 : data.h2Count === 1 ? 15 : 0) + (data.listCount >= 1 ? 30 : 0),
      status: data.h1Count === 1 && data.h2Count >= 2 ? 'pass' : data.h1Count >= 1 ? 'warning' : 'fail',
      details: `H1: ${data.h1Count}, H2: ${data.h2Count}, H3: ${data.h3Count}, Lists: ${data.listCount}`
    },
    {
      id: 'media_elements',
      name: 'Media & Engagement',
      description: 'Images, videos, and interactive elements',
      weight: 15,
      score: Math.min(100, (data.imageCount * 10) + (data.videoCount * 20)),
      status: data.imageCount >= 3 || data.videoCount >= 1 ? 'pass' : data.imageCount >= 1 ? 'warning' : 'fail',
      details: `Images: ${data.imageCount}, Videos: ${data.videoCount}`
    },
    {
      id: 'load_performance',
      name: 'Load Performance',
      description: 'Page response time and content ratio',
      weight: 15,
      score: data.loadTime < 2000 ? 100 : data.loadTime < 4000 ? 70 : data.loadTime < 6000 ? 40 : 20,
      status: data.loadTime < 2000 ? 'pass' : data.loadTime < 4000 ? 'warning' : 'fail',
      details: `Response time: ${data.loadTime}ms, Content ratio: ${Math.round(data.contentToHtmlRatio)}%`
    }
  ];

  // Calculate category scores
  Object.keys(categories).forEach(key => {
    const cat = categories[key];
    let totalWeight = 0;
    let weightedScore = 0;

    cat.criteria.forEach(criterion => {
      totalWeight += criterion.weight;
      weightedScore += criterion.score * criterion.weight;
    });

    cat.score = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;
  });

  return categories;
}

// Generate recommendations
export function generateRecommendations(categories: CategoryResults, checks: AuditChecks): Recommendation[] {
  const recommendations: Recommendation[] = [];

  const categoryNames: Record<string, string> = {
    technical_seo: 'Technical SEO',
    content_quality: 'Content Quality',
    ai_readiness: 'AI Readiness',
    security_trust: 'Security & Trust',
    user_experience: 'User Experience'
  };

  // Collect failing criteria
  Object.entries(categories).forEach(([key, data]) => {
    data.criteria.forEach(criterion => {
      if (criterion.status === 'fail' || criterion.status === 'warning') {
        const templates: Record<string, string> = {
          ssl: 'Enable SSL certificate and switch to HTTPS for security and SEO benefits',
          robots_txt: 'Create a robots.txt file to control search engine crawler access',
          sitemap: 'Create an XML sitemap and submit to Google Search Console',
          canonical: 'Add canonical tags to prevent duplicate content issues',
          meta_title: 'Optimize meta title to 30-60 characters with primary keyword',
          meta_description: 'Write compelling meta description (120-160 chars) with call-to-action',
          hreflang: 'Add hreflang tags if targeting multiple countries (e.g., en-sg for Singapore)',
          cdn: 'Implement a CDN (like Cloudflare) for faster global page loads',
          structured_data: 'Add JSON-LD structured data markup (FAQ, Article, Organization schemas)',
          semantic_html: 'Use semantic HTML5 elements (header, main, article, section, footer)',
          content_depth: 'Expand content to at least 800-1500 words with proper heading structure',
          internal_linking: 'Add more internal links to improve site structure and user navigation',
          eeata: 'Improve E-E-A-T-A: Add author info, publish dates, and expert credentials',
          llm_bots: 'Review robots.txt to allow AI crawlers (GPTBot, anthropic-ai, etc.)',
          llms_txt: 'Create llms.txt file with AI-specific content guidelines',
          llms_full_txt: 'Create llms-full.txt with comprehensive content for AI context',
          js_blocks_ai: 'Ensure content is server-rendered and accessible without JavaScript',
          faq_schema: 'Add FAQ schema markup for better visibility in AI search results',
          wordfence: 'Install Wordfence security plugin for WordPress protection',
          ga4: 'Install Google Analytics 4 for traffic tracking and insights',
          rank_math: 'Install Rank Math SEO plugin for better on-page optimization',
          mobile_viewport: 'Add viewport meta tag for proper mobile rendering',
          readability: 'Improve content readability with shorter sentences and clear formatting'
        };

        const text = templates[criterion.id] || `Improve ${criterion.name}: ${criterion.details}`;

        recommendations.push({
          text,
          priority: criterion.status === 'fail' ? 'high' : 'medium',
          category: categoryNames[key] || key,
          impact: criterion.weight >= 15 ? 'High' : criterion.weight >= 10 ? 'Medium' : 'Low'
        });
      }
    });
  });

  // Sort by priority and weight
  recommendations.sort((a, b) => {
    if (a.priority === 'high' && b.priority !== 'high') return -1;
    if (a.priority !== 'high' && b.priority === 'high') return 1;
    return 0;
  });

  return recommendations.slice(0, 10);
}

// Main analysis function
export async function analyzeWebsite(url: string): Promise<AnalysisResult> {
  // Fetch website
  const { html, loadTime, finalUrl, headers } = await fetchWebsite(url);

  // Get domain
  const urlObj = new URL(finalUrl);
  const domain = urlObj.hostname;

  // Fetch additional resources in parallel
  const [robotsTxt, sitemap, llmsTxt, llmsFullTxt] = await Promise.all([
    fetchRobotsTxt(domain),
    fetchSitemap(domain),
    fetchLlmsTxt(domain),
    fetchLlmsFullTxt(domain)
  ]);

  // Parse HTML
  const rawData = parseHTML(html, finalUrl, headers);
  rawData.loadTime = loadTime;

  // Generate audit checks
  const checks = generateAuditChecks(rawData, robotsTxt, sitemap, llmsTxt, llmsFullTxt);

  // Calculate scores
  const categories = calculateScores(rawData, checks);

  // Calculate overall score - WEIGHTED for GEO/AISEO priority
  // AI Readiness is weighted MORE heavily for GEO audit
  const categoryWeights: Record<string, number> = {
    technical_seo: 18,
    content_quality: 22,
    ai_readiness: 30,  // HIGHEST weight - this is a GEO audit
    security_trust: 15,
    user_experience: 15
  };

  let weightedTotal = 0;
  let totalWeight = 0;
  Object.entries(categories).forEach(([key, cat]) => {
    const weight = categoryWeights[key] || 20;
    weightedTotal += cat.score * weight;
    totalWeight += weight;
  });
  const overallScore = Math.round(weightedTotal / totalWeight);

  // Generate recommendations
  const recommendations = generateRecommendations(categories, checks);

  return {
    url: finalUrl,
    domain,
    timestamp: new Date().toISOString(),
    overallScore,
    categories,
    recommendations,
    rawData,
    checks
  };
}
