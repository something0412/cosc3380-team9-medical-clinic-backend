// offices don't store a time zone yet, so every clinic date and time uses this one
export const CLINIC_TIME_ZONE = "America/Chicago";

// the current clinic time and date for SQL, since the database itself runs on UTC
export const CLINIC_NOW = `(now() AT TIME ZONE '${CLINIC_TIME_ZONE}')`;
export const CLINIC_TODAY = `(${CLINIC_NOW})::date`;
