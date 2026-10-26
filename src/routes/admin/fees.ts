import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { moneySchema } from "../../services/billing.js";

// mounted at /api/admin/fees, so only admins reach these
export const adminFeesRouter = Router();

const id = z.coerce.number("Choose a fee").int("Choose a fee").positive("Choose a fee");
const typeText = z.string().trim().max(50, "Keep the type under 50 characters").nullish().transform((value) => value || null);
const updateBody = z.object({ price: moneySchema, type: typeText, isActive: z.boolean() });
const createBody = z.object({
  category: z.enum(["Visit", "Lab Test", "Medication"], "Category must be Visit, Lab Test or Medication"),
  linkId: z.number("Choose what this price is for").int().positive(),
  price: moneySchema,
  type: typeText,
});

// get every specialty, lab test, and medication with its price (feeId is null when it has no price yet)
adminFeesRouter.get("/", async (_req, res) => {
  // get each priced item with its fee, plus the ones still missing a fee
  const result = await pool.query(`
    SELECT
      f.fee_id AS "feeId",
      'Visit' AS category,
      s.specialty_id AS "linkId",
      COALESCE(f.name, s.name || ' visit') AS name,
      f.type,
      f.price,
      f.is_active AS "isActive",
      s.is_active AS "linkActive",
      to_char(f.updated_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI') AS "updatedAt"
    FROM specialty s
    LEFT JOIN service_fee f ON f.specialty_id = s.specialty_id
    UNION ALL
    SELECT f.fee_id, 'Lab Test', t.lab_test_type_id, COALESCE(f.name, t.name), f.type, f.price, f.is_active, t.is_active,
      to_char(f.updated_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI')
    FROM lab_test_type t
    LEFT JOIN service_fee f ON f.lab_test_type_id = t.lab_test_type_id
    UNION ALL
    SELECT f.fee_id, 'Medication', m.medication_id, COALESCE(f.name, m.name), f.type, f.price, f.is_active, m.is_active,
      to_char(f.updated_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI')
    FROM medication m
    LEFT JOIN service_fee f ON f.medication_id = m.medication_id
    ORDER BY category DESC, type NULLS FIRST, name
  `);

  res.json(result.rows);
});

// change a price, its type, or turn it on and off
adminFeesRouter.put("/:id", async (req, res) => {
  const feeId = id.parse(req.params.id);
  const { price, type, isActive } = updateBody.parse(req.body);

  // save the fee; invoices already made keep the price they were billed at
  const result = await pool.query(
    `
    UPDATE service_fee SET price = $2, type = $3, is_active = $4, updated_at = now()
    WHERE fee_id = $1
    RETURNING fee_id AS "feeId", category, name, type, price, is_active AS "isActive"
    `,
    [feeId, price, type, isActive]
  );
  if (!result.rowCount) throw new HttpError(404, "Fee not found");

  res.json(result.rows[0]);
});

// add a price for a specialty, lab test, or medication that doesn't have one
adminFeesRouter.post("/", async (req, res) => {
  const { category, linkId, price, type } = createBody.parse(req.body);

  // save the fee named after the specialty, lab test, or medication it prices
  const result = await pool.query(
    `
    INSERT INTO service_fee (category, type, name, price, specialty_id, lab_test_type_id, medication_id)
    SELECT $1::varchar, $2, n.name, $3, CASE WHEN $1 = 'Visit' THEN $4::int END, CASE WHEN $1 = 'Lab Test' THEN $4::int END, CASE WHEN $1 = 'Medication' THEN $4::int END
    FROM (
      SELECT name || ' visit' AS name FROM specialty WHERE $1 = 'Visit' AND specialty_id = $4
      UNION ALL SELECT name FROM lab_test_type WHERE $1 = 'Lab Test' AND lab_test_type_id = $4
      UNION ALL SELECT name FROM medication WHERE $1 = 'Medication' AND medication_id = $4
    ) n
    ON CONFLICT DO NOTHING
    RETURNING fee_id AS "feeId", category, name, type, price, is_active AS "isActive"
    `,
    [category, type, price, linkId]
  );
  if (!result.rowCount) throw new HttpError(409, "That item doesn't exist or already has a price");

  res.status(201).json(result.rows[0]);
});
