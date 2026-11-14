import { PaymentStatus } from "@appointly/prisma-client";

import { db } from "@/lib/db";
import { refundRazorpayPayment, verifyRazorpayWebhook } from "@/lib/integrations";

type RazorpayEvent = {
  event?: string;
  payload?: {
    payment_link?: { entity?: { id?: string; amount_paid?: number } };
    payment?: { entity?: { id?: string } };
    refund?: { entity?: { id?: string; payment_id?: string } };
  };
};

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (!signature || !verifyRazorpayWebhook(body, signature)) {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  let event: RazorpayEvent;
  try {
    event = JSON.parse(body) as RazorpayEvent;
  } catch {
    return Response.json({ error: "Invalid webhook payload." }, { status: 400 });
  }
  const paymentLink = event.payload?.payment_link?.entity;
  if (event.event === "refund.processed" || event.event === "refund.failed") {
    const refund = event.payload?.refund?.entity;
    if (!refund?.payment_id || !refund.id) return Response.json({ received: true });
    const payment = await db.payment.findFirst({ where: { externalPaymentId: refund.payment_id } });
    if (payment && event.event === "refund.processed" && payment.status === PaymentStatus.REFUND_PENDING) {
      await db.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.REFUNDED, refundId: refund.id, lastRefundError: null },
      });
    } else if (payment && event.event === "refund.failed" && payment.status === PaymentStatus.REFUND_PENDING) {
      await db.payment.update({
        where: { id: payment.id },
        data: { lastRefundError: "Razorpay reported that the refund failed." },
      });
    }
    return Response.json({ received: true });
  }
  if (!paymentLink?.id) return Response.json({ received: true });

  if (event.event === "payment_link.paid") {
    const payment = await db.payment.findUnique({
      where: { paymentLinkId: paymentLink.id },
      include: { booking: { select: { status: true } } },
    });
    if (!payment) return Response.json({ error: "Payment link is not recognized." }, { status: 404 });
    if (paymentLink.amount_paid !== payment.amountPaise || !event.payload?.payment?.entity?.id) {
      return Response.json({ error: "Paid amount does not match the booking amount." }, { status: 409 });
    }
    const wasCancelled = payment.bookingCancelledAt !== null || payment.booking.status === "CANCELLED";
    const updated = await db.payment.updateMany({
      where: { id: payment.id, status: { in: [PaymentStatus.PENDING, PaymentStatus.FAILED] } },
      data: {
        status: wasCancelled ? PaymentStatus.REFUND_PENDING : PaymentStatus.PAID,
        externalPaymentId: event.payload.payment.entity.id,
      },
    });
    if (updated.count && wasCancelled) {
      try {
        const refund = await refundRazorpayPayment(event.payload.payment.entity.id, payment.amountPaise);
        await db.payment.update({
          where: { id: payment.id },
          data: {
            status: refund.processed ? PaymentStatus.REFUNDED : PaymentStatus.REFUND_PENDING,
            refundId: refund.id,
            lastRefundError: null,
          },
        });
      } catch (error) {
        await db.payment.update({
          where: { id: payment.id },
          data: { lastRefundError: error instanceof Error ? error.message.slice(0, 300) : "Unknown refund error" },
        });
        console.error("Razorpay refund for a cancelled booking requires reconciliation", {
          bookingId: payment.bookingId,
          error: error instanceof Error ? error.message : "Unknown refund error",
        });
      }
    }
  } else if (event.event === "payment_link.cancelled") {
    await db.payment.updateMany({
      where: { paymentLinkId: paymentLink.id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.FAILED },
    });
  }

  return Response.json({ received: true });
}
