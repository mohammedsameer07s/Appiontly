import { NotificationChannel, type Prisma, type BookingStatus } from "@appointly/prisma-client";

export async function enqueueBookingUpdate(
  tx: Prisma.TransactionClient,
  bookingId: string,
  status: BookingStatus,
) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: { select: { name: true, email: true, phone: true, smsNotificationsEnabled: true } },
      business: {
        select: {
          name: true,
          timezone: true,
          owner: { select: { name: true, email: true, phone: true, smsNotificationsEnabled: true } },
        },
      },
    },
  });
  if (!booking) throw new Error("NOT_FOUND");
  const text = `${booking.business.name}: your appointment on ${booking.date.toISOString().slice(0, 10)} at ${formatMinute(booking.startMinute)} (${booking.timezone}) is ${status.toLowerCase()}.`;
  const dedupeBase = `${booking.id}:${booking.updatedAt.getTime()}:${status}`;
  const recipients = [
    { user: booking.customer, suffix: "customer" },
    { user: booking.business.owner, suffix: "provider" },
  ];
  await tx.notificationDelivery.createMany({
    data: recipients.flatMap(({ user, suffix }) => [
      {
        dedupeKey: `${dedupeBase}:${suffix}:email`,
        channel: NotificationChannel.EMAIL,
        recipient: user.email,
        subject: `Appointly booking ${status.toLowerCase()}`,
        body: `${user.name}, ${text}`,
      },
      ...(user.smsNotificationsEnabled
        ? [{
            dedupeKey: `${dedupeBase}:${suffix}:sms`,
            channel: NotificationChannel.SMS,
            recipient: user.phone,
            subject: "",
            body: text,
          }]
        : []),
    ]),
    skipDuplicates: true,
  });
}

export async function enqueueAccountMessage(
  tx: Prisma.TransactionClient,
  input: { channel: NotificationChannel; recipient: string; subject: string; body: string; dedupeKey: string },
) {
  await tx.notificationDelivery.create({ data: input });
}

function formatMinute(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
