import { Router } from "express";
import { pool } from "../lib/db.js";

export const appointmentBookingRouter = Router();
appointmentBookingRouter.use("/api/patient/:id/booking", (req, res, next) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
        res.status(400).json({ error: "Invalid patient ID" });
        return;
    }

    if (req.session.role !== "patient" || req.session.patientId !== id) {
        res.status(403).json({ error: "Please log in as this patient" });
        return;
    }

    next();
});


//get doctors who have a schedule
appointmentBookingRouter.get("/api/patient/:id/booking/doctors", async (_req, res) => {
    const result = await pool.query(`
        SELECT d.employee_id AS "doctorId",
               CONCAT(e.first_name, ' ', e.last_name) AS "doctorName"
        FROM doctor d
        JOIN employee e ON e.employee_id = d.employee_id
        WHERE e.is_active = true
          AND EXISTS (
              SELECT 1 FROM doctor_schedule ds
              WHERE ds.doctor_id = d.employee_id AND ds.is_active = true
          )
        ORDER BY e.last_name, e.first_name
    `);

    res.json(result.rows);
});


function validDate(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

    const date = new Date(value + "T00:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}


//find times from the doctor's schedule that nobody has booked yet
const slotsSql = `
    SELECT DISTINCT ON (t.time_slot_id)
           t.time_slot_id AS "timeSlotId", t.start_time AS "startTime",
           ds.office_id AS "officeId", ds.specialty_id AS "specialtyId"
    FROM doctor_schedule ds
    JOIN doctor d ON d.employee_id = ds.doctor_id
    JOIN employee e ON e.employee_id = d.employee_id
    JOIN time_slot t ON t.start_time >= ds.start_time AND t.start_time < ds.end_time
    WHERE ds.doctor_id = $1 AND ds.is_active = true AND e.is_active = true
      AND LOWER(TRIM(ds.day_of_week::text)) IN (
          LOWER(TO_CHAR($2::date, 'FMDay')),
          LOWER(TO_CHAR($2::date, 'Dy'))
      )
      AND ($2::date > CURRENT_DATE OR
          ($2::date = CURRENT_DATE AND t.start_time > LOCALTIME))
      AND NOT EXISTS (
          SELECT 1 FROM appointment a
          WHERE a.doctor_id = ds.doctor_id
            AND a.appointment_date = $2::date
            AND a.time_slot_id = t.time_slot_id
            AND LOWER(COALESCE(a.status, '')) NOT IN ('cancelled', 'canceled')
      )
    ORDER BY t.time_slot_id, ds.office_id
`;


//send the available times for a doctor and date
appointmentBookingRouter.get("/api/patient/:id/booking/slots", async (req, res) => {
    const doctorId = Number(req.query.doctorId);
    const date = req.query.date;

    if (!Number.isSafeInteger(doctorId) || doctorId <= 0 || !validDate(date)) {
        res.status(400).json({ error: "Choose a doctor and a valid date" });
        return;
    }

    const result = await pool.query(slotsSql, [doctorId, date]);

    res.json(result.rows.sort((a, b) =>
        String(a.startTime).localeCompare(String(b.startTime))
    ));
});


//save the appointment and check availability again first
appointmentBookingRouter.post("/api/patient/:id/booking", async (req, res) => {
    const patientId = Number(req.params.id);
    const doctorId = Number(req.body?.doctorId);
    const timeSlotId = Number(req.body?.timeSlotId);
    const date = req.body?.appointmentDate;

    if (!Number.isSafeInteger(doctorId) || doctorId <= 0 ||
        !Number.isSafeInteger(timeSlotId) || timeSlotId <= 0 || !validDate(date)) {
        res.status(400).json({ error: "Choose a doctor, date and time" });
        return;
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        //stop two bookings from taking the same time at once
        await client.query(
            "SELECT pg_advisory_xact_lock(4242, hashtext($1))",
            [`${date}:${timeSlotId}`]
        );

        const available = await client.query(slotsSql, [doctorId, date]);

        const slot = available.rows.find(
            row => Number(row.timeSlotId) === timeSlotId
        );

        if (!slot) {
            await client.query("ROLLBACK");
            res.status(409).json({ error: "That time is no longer available" });
            return;
        }

        const duplicate = await client.query(`
            SELECT 1 FROM appointment
            WHERE patient_id = $1 AND appointment_date = $2::date
              AND time_slot_id = $3
              AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'canceled')
            LIMIT 1
        `, [patientId, date, timeSlotId]);

        if (duplicate.rows.length > 0) {
            await client.query("ROLLBACK");
            res.status(409).json({ error: "You already have an appointment at this time" });
            return;
        }
        const result = await client.query(`
            INSERT INTO appointment
                (patient_id, doctor_id, office_id, specialty_id,
                 appointment_date, time_slot_id, status, booking_channel)
            VALUES ($1, $2, $3, $4, $5::date, $6, 'Scheduled', 'Online')
            RETURNING appointment_id AS "appointmentId"
        `, [
            patientId,
            doctorId,
            slot.officeId,
            slot.specialtyId,
            date,
            timeSlotId
        ]);

        await client.query("COMMIT");

        res.status(201).json(result.rows[0]);

    } catch (err) {
        await client.query("ROLLBACK");
        throw err;

    } finally {
        client.release();
    }
});