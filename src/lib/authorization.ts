import type { BookingStatus, UserRole } from "@appointly/prisma-client";

export function canManageBusiness(role: UserRole, userId: string, ownerId: string) {
  return role === "ADMIN" || (role === "PROVIDER" && userId === ownerId);
}

export function canCustomerManageBooking(
  role: UserRole,
  userId: string,
  customerId: string,
  status: BookingStatus,
  appointmentIsFuture: boolean,
) {
  return (
    role === "CUSTOMER" &&
    userId === customerId &&
    appointmentIsFuture &&
    (status === "PENDING" || status === "CONFIRMED")
  );
}

export function canReviewBooking(role: UserRole, userId: string, customerId: string, status: BookingStatus) {
  return role === "CUSTOMER" && userId === customerId && status === "COMPLETED";
}

export function canChangeAccountAccess(
  actorRole: UserRole,
  targetRole: UserRole,
  isActor: boolean,
  willBeActive: boolean,
) {
  return actorRole === "ADMIN" && targetRole !== "ADMIN" && (!isActor || willBeActive);
}
