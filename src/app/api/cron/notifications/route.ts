import { NotificationChannel, NotificationStatus } from "@appointly/prisma-client";

import { db } from "@/lib/db";
import { sendTransactionalEmail, sendTransactionalSms } from "@/lib/integrations";
import { enqueueBookingUpdate } from "@/lib/notifications";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Notification worker is not configured." }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  await db.notificationDelivery.updateMany({
    where: { status: NotificationStatus.PROCESSING, claimedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } },
    data: { status: NotificationStatus.PENDING, claimedAt: null },
  });
  await db.accountToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.adminMfaChallenge.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { consumedAt: { not: null } }] },
  });

  const expired = await db.booking.findMany({
    where: {
      status: "PENDING",
      createdAt: { lte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    select: { id: true },
    take: 100,
  });
  let expiredCount = 0;
  for (const { id } of expired) {
    const updated = await db.$transaction(async (tx) => {
      const result = await tx.booking.updateMany({
        where: { id, status: "PENDING", createdAt: { lte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        data: { status: "CANCELLED" },
      });
      if (result.count) await enqueueBookingUpdate(tx, id, "CANCELLED");
      return result.count;
    });
    expiredCount += updated;
  }

  const deliveries = await db.notificationDelivery.findMany({
    where: { status: NotificationStatus.PENDING, nextAttemptAt: { lte: new Date() }, attempts: { lt: 8 } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  let sentCount = 0;
  let failedCount = 0;
  for (const delivery of deliveries) {
    const claimed = await db.notificationDelivery.updateMany({
      where: { id: delivery.id, status: NotificationStatus.PENDING },
      data: { status: NotificationStatus.PROCESSING, claimedAt: new Date() },
    });
    if (!claimed.count) continue;
    try {
      if (delivery.channel === NotificationChannel.EMAIL) {
        await sendTransactionalEmail(delivery.recipient, delivery.subject, delivery.body);
      } else {
        await sendTransactionalSms(delivery.recipient, delivery.body);
      }
      const updated = await db.notificationDelivery.updateMany({
        where: { id: delivery.id, status: NotificationStatus.PROCESSING },
        data: { status: NotificationStatus.SENT, sentAt: new Date(), lastError: null, claimedAt: null },
      });
      sentCount += updated.count;
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const nextAttemptAt = new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000);
      await db.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationStatus.PENDING,
          attempts,
          lastError: error instanceof Error ? error.message.slice(0, 300) : "Unknown notification delivery error",
          nextAttemptAt,
          claimedAt: null,
        },
      });
      failedCount += 1;
    }
  }

  return Response.json({
    expiredBookings: expiredCount,
    sentNotifications: sentCount,
    failedNotifications: failedCount,
    attemptedNotifications: deliveries.length,
  });
}
