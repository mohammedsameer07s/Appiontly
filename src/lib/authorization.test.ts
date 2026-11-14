import assert from "node:assert/strict";
import test from "node:test";

import { canChangeAccountAccess, canCustomerManageBooking, canManageBusiness, canReviewBooking } from "./authorization";

test("providers manage only their own listings and admins can moderate any listing", () => {
  assert.equal(canManageBusiness("PROVIDER", "owner-1", "owner-1"), true);
  assert.equal(canManageBusiness("PROVIDER", "owner-2", "owner-1"), false);
  assert.equal(canManageBusiness("CUSTOMER", "owner-1", "owner-1"), false);
  assert.equal(canManageBusiness("ADMIN", "admin-1", "owner-1"), true);
});

test("customers can change only their future active bookings and review only completed visits", () => {
  assert.equal(canCustomerManageBooking("CUSTOMER", "cust-1", "cust-1", "PENDING", true), true);
  assert.equal(canCustomerManageBooking("CUSTOMER", "cust-2", "cust-1", "PENDING", true), false);
  assert.equal(canCustomerManageBooking("CUSTOMER", "cust-1", "cust-1", "COMPLETED", true), false);
  assert.equal(canCustomerManageBooking("CUSTOMER", "cust-1", "cust-1", "CONFIRMED", false), false);
  assert.equal(canReviewBooking("CUSTOMER", "cust-1", "cust-1", "COMPLETED"), true);
  assert.equal(canReviewBooking("CUSTOMER", "cust-1", "cust-1", "CONFIRMED"), false);
});

test("admins can suspend non-admin accounts but not themselves or another administrator", () => {
  assert.equal(canChangeAccountAccess("ADMIN", "PROVIDER", false, false), true);
  assert.equal(canChangeAccountAccess("ADMIN", "ADMIN", false, false), false);
  assert.equal(canChangeAccountAccess("ADMIN", "ADMIN", true, false), false);
  assert.equal(canChangeAccountAccess("ADMIN", "ADMIN", true, true), false);
  assert.equal(canChangeAccountAccess("CUSTOMER", "PROVIDER", false, false), false);
});
