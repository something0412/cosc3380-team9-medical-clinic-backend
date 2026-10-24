import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const adminSpecialtiesRouter = Router();

const idParam = z.coerce.number().int().positive();

const specialtySchema = z.object({
  name: z.string().trim().min(1, "Specialty name is required").max(100, "Specialty name must be 100 characters or less"),
  requiresReferral: z.boolean("Requires referral must be true or false"),
});

const statusSchema = z.object({ isActive: z.boolean("Status must be true or false") });

// one specialty with doctor and schedule counts, or null if not found
async function loadSpecialty(specialtyId: number) {
  const result = await pool.query(
    `
    SELECT
      s.specialty_id AS "specialtyId",
      s.name,
      s.requires_referral AS "requiresReferral",
      s.is_active AS "isActive",
      (SELECT COUNT(*) FROM doctor_specialty ds WHERE ds.specialty_id = s.specialty_id AND ds.is_active)::int AS "doctorCount",
      (
        SELECT COUNT(*)
        FROM doctor_specialty ds
        JOIN employee e ON e.employee_id = ds.doctor_id
        WHERE ds.specialty_id = s.specialty_id AND ds.is_active AND e.is_active
      )::int AS "activeDoctorCount",
      (SELECT COUNT(*) FROM doctor_schedule sch WHERE sch.specialty_id = s.specialty_id AND sch.is_active)::int AS "activeScheduleCount"
    FROM specialty s
    WHERE s.specialty_id = $1
    `,
    [specialtyId]
  );
  return result.rows[0] ?? null;
}

// names are unique, but the database check is case sensitive, so also compare them in lowercase
async function checkName(name: string, specialtyId: number | null) {
  const result = await pool.query(`SELECT 1 FROM specialty WHERE LOWER(name) = LOWER($1) AND specialty_id <> $2`, [name, specialtyId ?? 0]);
  if (result.rowCount) throw new HttpError(409, "A specialty with that name already exists");
}

function duplicateNameError(err: unknown) {
  const { constraint } = err as { constraint?: string };
  return constraint === "specialty_name_key" ? new HttpError(409, "A specialty with that name already exists") : err;
}

// specialty directory, also used by the doctor specialty checkboxes
adminSpecialtiesRouter.get("/", async (_req, res) => {
  const result = await pool.query(`
    SELECT
      specialty_id AS "specialtyId",
      name,
      requires_referral AS "requiresReferral",
      is_active AS "isActive"
    FROM specialty
    ORDER BY name
  `);

  res.json(result.rows);
});

// one specialty with its doctor and schedule counts
adminSpecialtiesRouter.get("/:id", async (req, res) => {
  const specialty = await loadSpecialty(idParam.parse(req.params.id));
  if (!specialty) throw new HttpError(404, "Specialty not found");
  res.json(specialty);
});

// create a specialty, which starts out active and unassigned
adminSpecialtiesRouter.post("/", async (req, res) => {
  const body = specialtySchema.parse(req.body);
  await checkName(body.name, null);

  const created = await pool
    .query(
      `INSERT INTO specialty (name, requires_referral) VALUES ($1, $2) RETURNING specialty_id AS "specialtyId"`,
      [body.name, body.requiresReferral]
    )
    .catch((err) => {
      throw duplicateNameError(err);
    });

  res.status(201).json(await loadSpecialty(created.rows[0].specialtyId));
});

// update the name and referral rule. This applies to future bookings and leaves existing records as is
adminSpecialtiesRouter.put("/:id", async (req, res) => {
  const specialtyId = idParam.parse(req.params.id);
  const body = specialtySchema.parse(req.body);
  await checkName(body.name, specialtyId);

  const result = await pool
    .query(`UPDATE specialty SET name = $2, requires_referral = $3 WHERE specialty_id = $1`, [
      specialtyId,
      body.name,
      body.requiresReferral,
    ])
    .catch((err) => {
      throw duplicateNameError(err);
    });
  if (!result.rowCount) throw new HttpError(404, "Specialty not found");

  res.json(await loadSpecialty(specialtyId));
});

// activate or deactivate a specialty without changing doctor assignments or schedules
adminSpecialtiesRouter.patch("/:id/status", async (req, res) => {
  const specialtyId = idParam.parse(req.params.id);
  const { isActive } = statusSchema.parse(req.body);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock the specialty so the checks and update see the same state
    const current = await client.query(`SELECT is_active AS "isActive" FROM specialty WHERE specialty_id = $1 FOR UPDATE`, [specialtyId]);
    if (!current.rowCount) throw new HttpError(404, "Specialty not found");

    if (current.rows[0].isActive !== isActive) {
      if (!isActive) {
        const used = await client.query(
          `
          SELECT
            (
              SELECT COUNT(*)
              FROM doctor_specialty ds
              JOIN employee e ON e.employee_id = ds.doctor_id
              WHERE ds.specialty_id = $1 AND ds.is_active AND e.is_active
            )::int AS doctors,
            (SELECT COUNT(*) FROM doctor_schedule WHERE specialty_id = $1 AND is_active)::int AS schedules
          `,
          [specialtyId]
        );
        const { doctors, schedules } = used.rows[0];
        if (doctors || schedules) {
          const parts = [];
          if (doctors) parts.push(`${doctors} active doctor${doctors === 1 ? "" : "s"}`);
          if (schedules) parts.push(`${schedules} active doctor schedule${schedules === 1 ? "" : "s"}`);
          throw new HttpError(409, `This specialty is still used by ${parts.join(" and ")}. Update them before deactivating the specialty.`);
        }
      }

      await client.query(`UPDATE specialty SET is_active = $2 WHERE specialty_id = $1`, [specialtyId, isActive]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.json(await loadSpecialty(specialtyId));
});
