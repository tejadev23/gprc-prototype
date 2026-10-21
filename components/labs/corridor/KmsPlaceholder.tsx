"use client";

export function KmsPlaceholder() {
  return (
    <div className="max-w-3xl space-y-2 text-[12px] leading-snug text-muted">
      <p className="text-foreground">KMS export is a future capability.</p>
      <p>
        This prototype does not write a KMS file. Export will wait until station and offset can be projected onto a
        centerline as northing, easting, and elevation.
      </p>
    </div>
  );
}
