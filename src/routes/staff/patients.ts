import { Router } from "express";
import { pool } from "../../lib/db.js";

export const staffPatientsRouter = Router();

staffPatientsRouter.get("/api/patients", async (_req, res) => {
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


staffPatientsRouter.post("/api/patients", async (req, res) => {
    const {
        firstName,
        lastName,
        dob,
        gender,
        phone,
        email,
        address
    } = req.body ?? {};

    if (
        typeof firstName !== "string" || !firstName.trim() ||
        typeof lastName !== "string" || !lastName.trim() ||
        typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dob) ||
        typeof phone !== "string" || !phone.trim()
    ) {
        res.status(400).json({ error: "Valid first name, last name, DOB, and phone are required" });
        return;
    }

    if ([gender, email, address].some((value) => value != null && typeof value !== "string")) {
        res.status(400).json({ error: "Invalid patient information" });
        return;
    }

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
