import { Router } from "express";
import { pool } from "../lib/db.js";

export const patientsRouter = Router();

// No controllers folder: for a learning project this small, splitting
// "route" and "controller" into two files per entity was extra
// indirection without enough payoff. Each route handler just writes its
// own SQL and shapes its own response — copy this file's shape
// (Router + pool.query + res.json) for new entities (appointments,
// doctors, etc.) instead of creating a controllers/*.ts file.
//
// Columns in the real `patient` table (see clinic_database_dump.sql) are
// snake_case, matching normal SQL convention. We alias them to camelCase
// in the SELECT itself so the JSON this API returns matches normal
// JS/TS naming — that way the translation happens once, here, instead of
// every frontend component having to deal with snake_case field names.

//get all patient
patientsRouter.get("/api/patients", async (_req, res) => {
  const result = await pool.query(`
    SELECT
      patient_id AS "patientId",
      first_name AS "firstName",
      last_name AS "lastName",
      dob,
      phone,
      email,
      is_active AS "isActive"
    FROM patient
    ORDER BY patient_id
  `);

  res.json(result.rows);
});


//add a new patient
patientsRouter.post("/api/patients", async (req, res) => {
    const {
        firstName,
        lastName,
        dob,
        gender,
        phone,
        email,
        address
    } = req.body;
    const result = await pool.query(
        `
        INSERT INTO patient
            (first_name, last_name, dob, gender, phone, email, address, is_active)
        VALUES
            ($1, $2, $3, $4, $5, $6, $7, true)
        RETURNING
            patient_id AS "patientId",
            first_name AS "firstName",
            last_name AS "lastName",
            dob,
            gender,
            phone,
            email,
            address,
            is_active AS "isActive"
        `,
        [
            firstName,
            lastName,
            dob,
            gender || null,
            phone,
            email || null,
            address || null
        ]
    );
    res.status(201).json(result.rows[0]);
});