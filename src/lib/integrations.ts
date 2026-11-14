import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export type BookingUpdate = {
  bookingId: string;
  status: "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED";
};

export interface BookingNotificationAdapter {
  sendBookingUpdate(recipient: string, update: BookingUpdate): Promise<void>;
}

export interface PaymentAdapter {
  createBookingPayment(bookingId: string, amountInPaise: number): Promise<{ checkoutUrl: string }>;
}

export type ExternalAdapters = {
  notifications?: BookingNotificationAdapter;
  payments?: PaymentAdapter;
};

export const externalAdapters: ExternalAdapters = Object.freeze({});

export async function sendTransactionalEmail(recipient: string, subject: string, text: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("EMAIL_PROVIDER_NOT_CONFIGURED");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [recipient], subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`EMAIL_PROVIDER_ERROR_${response.status}`);
}

export async function sendTransactionalSms(recipient: string, text: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !from) throw new Error("SMS_PROVIDER_NOT_CONFIGURED");
  const to = recipient.replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(to)) throw new Error("SMS_RECIPIENT_MUST_BE_E164");
  const body = new URLSearchParams({ To: to, From: from, Body: text });
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`SMS_PROVIDER_ERROR_${response.status}`);
}

export function isRazorpayConfigured() {
  return Boolean(
    process.env.RAZORPAY_KEY_ID &&
      process.env.RAZORPAY_KEY_SECRET &&
      process.env.RAZORPAY_WEBHOOK_SECRET &&
      process.env.APP_URL,
  );
}

export async function createRazorpayPaymentLink(input: {
  amountPaise: number;
  referenceId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  description: string;
}) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const appUrl = process.env.APP_URL?.replace(/\/+$/, "");
  if (!keyId || !keySecret || !appUrl) throw new Error("PAYMENTS_NOT_CONFIGURED");
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: "INR",
      accept_partial: false,
      reference_id: input.referenceId,
      description: input.description,
      customer: { name: input.customerName, email: input.customerEmail, contact: input.customerPhone },
      notify: { email: false, sms: false },
      reminder_enable: false,
      callback_url: `${appUrl}/my-bookings`,
      callback_method: "get",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RAZORPAY_ERROR_${response.status}`);
  const result = await response.json() as { id?: string; short_url?: string };
  if (!result.id || !result.short_url) throw new Error("RAZORPAY_INVALID_RESPONSE");
  return { id: result.id, url: result.short_url };
}

export async function refundRazorpayPayment(paymentId: string, amountPaise: number) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("PAYMENTS_NOT_CONFIGURED");
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountPaise, speed: "normal" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RAZORPAY_REFUND_ERROR_${response.status}`);
  const result = await response.json() as { id?: string; status?: string };
  if (!result.id) throw new Error("RAZORPAY_INVALID_RESPONSE");
  return { id: result.id, processed: result.status === "processed" };
}

export async function cancelRazorpayPaymentLink(paymentLinkId: string) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("PAYMENTS_NOT_CONFIGURED");
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const response = await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(paymentLinkId)}/cancel`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && response.status !== 400) throw new Error(`RAZORPAY_CANCEL_LINK_ERROR_${response.status}`);
}

export function verifyRazorpayWebhook(body: string, signature: string) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
