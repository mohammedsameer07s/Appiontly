DROP INDEX IF EXISTS "Availability_businessId_weekday_key";

ALTER TABLE "Business"
ADD COLUMN "latitude" DOUBLE PRECISION,
ADD COLUMN "longitude" DOUBLE PRECISION;

ALTER TABLE "Business"
ADD CONSTRAINT "Business_coordinates_check"
CHECK (
    (("latitude" IS NULL) = ("longitude" IS NULL))
    AND ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90))
    AND ("longitude" IS NULL OR ("longitude" BETWEEN -180 AND 180))
);

CREATE INDEX "Availability_businessId_weekday_openingMinute_idx"
ON "Availability"("businessId", "weekday", "openingMinute");

CREATE TABLE "ScheduleException" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ScheduleException_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScheduleExceptionShift" (
    "id" TEXT NOT NULL,
    "exceptionId" TEXT NOT NULL,
    "openingMinute" INTEGER NOT NULL,
    "closingMinute" INTEGER NOT NULL,
    CONSTRAINT "ScheduleExceptionShift_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScheduleException_businessId_date_key"
ON "ScheduleException"("businessId", "date");
CREATE INDEX "ScheduleException_businessId_date_idx"
ON "ScheduleException"("businessId", "date");
CREATE INDEX "ScheduleExceptionShift_exceptionId_openingMinute_idx"
ON "ScheduleExceptionShift"("exceptionId", "openingMinute");

ALTER TABLE "ScheduleException"
ADD CONSTRAINT "ScheduleException_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScheduleExceptionShift"
ADD CONSTRAINT "ScheduleExceptionShift_exceptionId_fkey"
FOREIGN KEY ("exceptionId") REFERENCES "ScheduleException"("id") ON DELETE CASCADE ON UPDATE CASCADE;
