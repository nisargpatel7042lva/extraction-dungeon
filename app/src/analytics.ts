// Analytics, in two layers:
//  - Vercel Web Analytics: page views, visitors, countries, devices (works on the free plan; enable it
//    in the Vercel dashboard → Analytics).
//  - Google Analytics 4: the gameplay funnel (wallet connected → game created/joined → started →
//    extracted → payout claimed), when VITE_GA_ID (a G-XXXXXXX measurement ID) is set at build time.
// Nothing personal is sent: no wallet addresses, keys or run accounts, only counts and categories.
import { inject } from "@vercel/analytics";

const GA_ID = (import.meta.env.VITE_GA_ID as string | undefined)?.trim();
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const isTest = new URLSearchParams(location.search).has("dev");

type Gtag = (...args: unknown[]) => void;
let gtag: Gtag | null = null;

export function initAnalytics() {
  // Local dev and dev-wallet test sessions don't count as real players.
  if (isLocal || isTest) return;
  inject({ mode: "production" });
  if (GA_ID && /^G-[A-Z0-9]+$/.test(GA_ID)) {
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(s);
    const w = window as unknown as { dataLayer: unknown[]; gtag: Gtag };
    w.dataLayer = w.dataLayer || [];
    w.gtag = function () {
      // gtag expects the real `arguments` object.
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer.push(arguments);
    };
    gtag = w.gtag;
    gtag("js", new Date());
    gtag("config", GA_ID, { anonymize_ip: true });
  }
}

/** One gameplay event. Params are small categorical values only (never wallet addresses). */
export function track(event: string, params: Record<string, string | number | boolean> = {}) {
  try {
    gtag?.("event", event, params);
  } catch {
    /* analytics must never break the game */
  }
}
