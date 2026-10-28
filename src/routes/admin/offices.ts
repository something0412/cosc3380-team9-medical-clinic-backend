import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const adminOfficesRouter = Router();

const idParam = z.coerce.number().int().positive();

// 50 states plus DC
const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

// required text with readable error messages
const text = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} must be ${max} characters or less`);

const officeSchema = z.object({
  name: text("Office name", 100),
  street: text("Street address", 100),
  apt: z
    .string()
    .trim()
    .max(20, "Apt / Suite must be 20 characters or less")
    .nullish()
    .transform((apt) => apt || null),
  city: text("City", 50),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .refine((state) => US_STATES.includes(state), "Select a valid US state"),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "ZIP code must be 5 digits or ZIP+4 (12345-6789)"),
  // digits only, exactly 10
  phone: z.string("Phone is required").trim().regex(/^\d{10}$/, "Phone must be exactly 10 digits"),
});

const statusSchema = z.object({ isActive: z.boolean("Status must be true or false") });

// one office with employee and schedule counts, or null if not found
async function loadOffice(officeId: number) {
  const result = await pool.query(
    `
    SELECT
      o.office_id AS "officeId",
      o.name,
      o.apt,
      o.street,
      o.city,
      o.state,
      o.zip,
      o.phone,
      o.is_active AS "isActive",
      (SELECT COUNT(*) FROM employee e WHERE e.office_id = o.office_id)::int AS "employeeCount",
      (SELECT COUNT(*) FROM employee e WHERE e.office_id = o.office_id AND e.is_active)::int AS "activeEmployeeCount",
      (SELECT COUNT(*) FROM doctor_schedule ds WHERE ds.office_id = o.office_id AND ds.is_active)::int AS "activeScheduleCount"
    FROM office o
    WHERE o.office_id = $1
    `,
    [officeId]
  );
  return result.rows[0] ?? null;
}

// office directory, also used by the employee form dropdown
adminOfficesRouter.get("/", async (_req, res) => {
  const result = await pool.query(`
    SELECT
      office_id AS "officeId",
      name,
      apt,
      street,
      city,
      state,
      zip,
      phone,
      is_active AS "isActive"
    FROM office
    ORDER BY name
  `);

  res.json(result.rows);
});

adminOfficesRouter.get("/:id", async (req, res) => {
  const office = await loadOffice(idParam.parse(req.params.id));
  if (!office) throw new HttpError(404, "Office not found");
  res.json(office);
});

// create an office, which starts out active
adminOfficesRouter.post("/", async (req, res) => {
  const body = officeSchema.parse(req.body);

  const created = await pool.query(
    `
    INSERT INTO office (name, apt, street, city, state, zip, phone)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING office_id AS "officeId"
    `,
    [body.name, body.apt, body.street, body.city, body.state, body.zip, body.phone]
  );

  res.status(201).json(await loadOffice(created.rows[0].officeId));
});

// update office details. Active status is changed separately
adminOfficesRouter.put("/:id", async (req, res) => {
  const officeId = idParam.parse(req.params.id);
  const body = officeSchema.parse(req.body);

  const result = await pool.query(
    `
    UPDATE office
    SET name = $2, apt = $3, street = $4, city = $5, state = $6, zip = $7, phone = $8
    WHERE office_id = $1
    `,
    [officeId, body.name, body.apt, body.street, body.city, body.state, body.zip, body.phone]
  );
  if (!result.rowCount) throw new HttpError(404, "Office not found");

  res.json(await loadOffice(officeId));
});

// activate or deactivate an office without changing anything assigned to it
adminOfficesRouter.patch("/:id/status", async (req, res) => {
  const officeId = idParam.parse(req.params.id);
  const { isActive } = statusSchema.parse(req.body);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock the office so the checks and update see the same state
    const current = await client.query(`SELECT is_active AS "isActive" FROM office WHERE office_id = $1 FOR UPDATE`, [officeId]);
    if (!current.rowCount) throw new HttpError(404, "Office not found");

    if (current.rows[0].isActive !== isActive) {
      if (!isActive) {
        const assigned = await client.query(
          `
          SELECT
            (SELECT COUNT(*) FROM employee WHERE office_id = $1 AND is_active)::int AS employees,
            (SELECT COUNT(*) FROM doctor_schedule WHERE office_id = $1 AND is_active)::int AS schedules
          `,
          [officeId]
        );
        const { employees, schedules } = assigned.rows[0];
        if (employees || schedules) {
          const parts = [];
          if (employees) parts.push(`${employees} active employee${employees === 1 ? "" : "s"}`);
          if (schedules) parts.push(`${schedules} active doctor schedule${schedules === 1 ? "" : "s"}`);
          throw new HttpError(409, `This office still has ${parts.join(" and ")}. Reassign them before deactivating the office.`);
        }
      }

      await client.query(`UPDATE office SET is_active = $2 WHERE office_id = $1`, [officeId, isActive]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.json(await loadOffice(officeId));
});
