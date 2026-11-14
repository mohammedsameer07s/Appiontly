import prismaPackage from "@appointly/prisma-client";
import bcrypt from "bcryptjs";

const { PrismaClient, UserRole } = prismaPackage;
const db = new PrismaClient();
const categories = [
  "Healthcare",
  "Restaurants",
  "Hotels",
  "Salons",
  "Automotive",
  "Fitness",
  "Education",
  "Professional Services",
];

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  for (const name of categories) {
    await db.category.upsert({
      where: { name },
      update: {},
      create: { name, slug: slugify(name) },
    });
  }

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("ADMIN_EMAIL must be a valid email address.");
    }
    if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
      throw new Error("ADMIN_PASSWORD must be 12-72 UTF-8 bytes.");
    }
    const existing = await db.user.findUnique({ where: { email }, select: { role: true } });
    if (existing && existing.role !== UserRole.ADMIN) {
      throw new Error("ADMIN_EMAIL already belongs to a non-administrator account.");
    }
    if (!existing) {
      await db.user.create({
        data: {
          name: process.env.ADMIN_NAME?.trim().slice(0, 80) || "Appointly administrator",
          email,
          phone: process.env.ADMIN_PHONE?.trim() || "",
          passwordHash: await bcrypt.hash(password, 12),
          role: UserRole.ADMIN,
          emailVerifiedAt: new Date(),
        },
      });
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => db.$disconnect());
