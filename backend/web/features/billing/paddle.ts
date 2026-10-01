/*
 * Paddle.js overlay checkout (PRODUCT.md §11 "Checkout"). The script is loaded only when someone
 * starts a checkout, so no third-party code runs in the app otherwise. Paddle takes the card; this app
 * never sees it. The plan is activated by Paddle's webhook, not by anything the browser reports.
 * Checked against developer.paddle.com on 2026-10-01 (Paddle.js v2: Initialize, Checkout.open).
 */
import type { CheckoutSession } from "@app/shared";

export const PADDLE_JS_URL = "https://cdn.paddle.com/paddle/v2/paddle.js";

export interface PaddleEvent {
  name?: string;
}

interface PaddleGlobal {
  Environment: { set(environment: "sandbox" | "production"): void };
  Initialize(options: { token: string; eventCallback?: (event: PaddleEvent) => void }): void;
  Checkout: {
    open(options: {
      items: Array<{ priceId: string; quantity: number }>;
      customer?: { email: string };
      customData?: Record<string, string>;
      discountId?: string;
      settings?: { displayMode: "overlay"; theme: "light" | "dark"; allowLogout: boolean };
    }): void;
  };
}

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

let loading: Promise<PaddleGlobal> | undefined;
let initialized = false;
/* Paddle takes one event callback at Initialize; it forwards to whoever opened the checkout last. */
let listener: ((event: PaddleEvent) => void) | undefined;

function loadPaddle(): Promise<PaddleGlobal> {
  loading ??= new Promise<PaddleGlobal>((resolve, reject) => {
    if (window.Paddle) {
      resolve(window.Paddle);
      return;
    }
    const script = document.createElement("script");
    script.src = PADDLE_JS_URL;
    script.async = true;
    script.onload = () => {
      if (window.Paddle) resolve(window.Paddle);
      else reject(new Error("Paddle.js loaded without a Paddle object."));
    };
    script.onerror = () => {
      loading = undefined;
      reject(
        new Error("The payment form couldn't be loaded. Check your connection or an ad blocker."),
      );
    };
    document.head.appendChild(script);
  });
  return loading;
}

export async function openCheckout(options: {
  paddle: { environment: "sandbox" | "production"; clientToken: string };
  session: CheckoutSession;
  theme: "light" | "dark";
  onEvent: (event: PaddleEvent) => void;
}): Promise<void> {
  const paddle = await loadPaddle();
  listener = options.onEvent;
  if (!initialized) {
    if (options.paddle.environment === "sandbox") paddle.Environment.set("sandbox");
    paddle.Initialize({
      token: options.paddle.clientToken,
      eventCallback: (event) => listener?.(event),
    });
    initialized = true;
  }
  paddle.Checkout.open({
    items: options.session.items,
    customer: { email: options.session.customerEmail },
    customData: options.session.customData,
    ...(options.session.discountId === null ? {} : { discountId: options.session.discountId }),
    settings: { displayMode: "overlay", theme: options.theme, allowLogout: false },
  });
}
