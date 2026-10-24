import { Router } from "express";
import { pool } from "../../lib/db.js";

export const patientPortalRouter = Router();

// get patient appointments
patientPortalRouter.get("/api/patient/:id/appointments", async (req, res) => {
    const patientId = Number(req.params.id);

    const result = await pool.query(
        `
        SELECT
            a.appointment_id AS "appointmentId",
            a.appointment_date AS "appointmentDate",
            t.start_time AS "appointmentTime",
            CONCAT(e.first_name, ' ', e.last_name) AS "doctorName",
            s.name AS "specialty",
            a.status
        FROM appointment a
        JOIN employee e ON a.doctor_id = e.employee_id
        LEFT JOIN time_slot t ON a.time_slot_id = t.time_slot_id
        LEFT JOIN specialty s ON a.specialty_id = s.specialty_id
        WHERE a.patient_id = $1
        ORDER BY a.appointment_date DESC, t.start_time DESC
        `,
        [patientId]
    );

    res.json(result.rows);
});


// get patient forms
patientPortalRouter.get("/api/patient/:id/forms", async (req, res) => {
    const patientId = Number(req.params.id);

    const result = await pool.query(
        `
        SELECT
            f.form_type_id AS "formTypeId",
            f.name,
            f.is_required AS "isRequired",
            fs.status,
            fs.submitted_date AS "submittedDate"
        FROM form_type f
        LEFT JOIN LATERAL (
            SELECT
                status,
                submitted_date
            FROM form_submission
            WHERE form_type_id = f.form_type_id
              AND patient_id = $1
            ORDER BY submitted_date DESC NULLS LAST,
                     form_submission_id DESC
            LIMIT 1
        ) fs ON true
        WHERE f.is_active = true
        ORDER BY f.form_type_id
        `,
        [patientId]
    );

    res.json(result.rows);
});


// get patient billing information
patientPortalRouter.get("/api/patient/:id/billing", async (req, res) => {
    const patientId = Number(req.params.id);

    const invoices = await pool.query(
        `
        SELECT
            invoice_id AS "invoiceId",
            issue_date AS "issueDate",
            amount,
            status
        FROM invoice
        WHERE patient_id = $1
        ORDER BY issue_date DESC, invoice_id DESC
        `,
        [patientId]
    );

    const payments = await pool.query(
        `
        SELECT
            p.payment_id AS "paymentId",
            p.invoice_id AS "invoiceId",
            p.payment_date AS "paymentDate",
            p.amount_paid AS "amountPaid",
            pt.name AS "paymentType"
        FROM payment p
        JOIN invoice i ON p.invoice_id = i.invoice_id
        JOIN payment_type pt ON p.payment_type_id = pt.payment_type_id
        WHERE i.patient_id = $1
        ORDER BY p.payment_date DESC, p.payment_id DESC
        `,
        [patientId]
    );

    res.json({
        invoices: invoices.rows,
        payments: payments.rows
    });
});


// get patient medical records
patientPortalRouter.get("/api/patient/:id/records", async (req, res) => {
    const patientId = Number(req.params.id);

    const visits = await pool.query(
        `
        SELECT
            a.appointment_id AS "appointmentId",
            a.appointment_date AS "visitDate",
            -- a visit can have several diagnoses, null when none are recorded
            (
                SELECT string_agg(d.name, ', ' ORDER BY d.created_at, d.visit_diagnosis_id)
                FROM visit_diagnosis d
                WHERE d.appointment_id = a.appointment_id
            ) AS diagnosis,
            s.visit_reason AS "visitReason",
            s.notes
        FROM appointment_summary s
        JOIN appointment a ON s.appointment_id = a.appointment_id
        WHERE a.patient_id = $1
        ORDER BY a.appointment_date DESC
        `,
        [patientId]
    );

    const prescriptions = await pool.query(
        `
        SELECT
            pi.prescription_item_id AS "prescriptionItemId",
            m.name AS "medicationName",
            pi.dosage,
            pi.instructions,
            pi.is_active AS "isActive"
        FROM prescription_item pi
        JOIN prescription p ON pi.prescription_id = p.prescription_id
        JOIN medication m ON pi.medication_id = m.medication_id
        WHERE p.patient_id = $1
        ORDER BY pi.prescription_item_id DESC
        `,
        [patientId]
    );

    const labResults = await pool.query(
        `
        SELECT
            l.lab_order_id AS "labOrderId",
            t.name AS "testName",
            l.order_date AS "orderDate",
            l.result_notes AS "resultNotes"
        FROM lab_order l
        JOIN lab_test_type t ON l.lab_test_type_id = t.lab_test_type_id
        WHERE l.patient_id = $1
        ORDER BY l.order_date DESC
        `,
        [patientId]
    );

    res.json({
        visits: visits.rows,
        prescriptions: prescriptions.rows,
        labResults: labResults.rows
    });
});


// get patient dashboard summary
patientPortalRouter.get("/api/patient/:id/dashboard", async (req, res) => {
    const patientId = Number(req.params.id);

    const appointments = await pool.query(
        `
        SELECT COUNT(*)::int AS total
        FROM appointment
        WHERE patient_id = $1
          AND appointment_date >= CURRENT_DATE
          AND LOWER(COALESCE(status, '')) NOT IN
              ('cancelled', 'completed', 'no-show')
        `,
        [patientId]
    );

    const forms = await pool.query(
        `
        SELECT COUNT(*)::int AS total
        FROM form_type f
        WHERE f.is_required = true
          AND f.is_active = true
          AND NOT EXISTS (
              SELECT 1
              FROM form_submission fs
              WHERE fs.form_type_id = f.form_type_id
                AND fs.patient_id = $1
                AND LOWER(fs.status) IN ('completed', 'submitted')
          )
        `,
        [patientId]
    );

    const billing = await pool.query(
        `
        SELECT COALESCE(
            SUM(
                GREATEST(
                    i.amount - COALESCE(
                        (
                            SELECT SUM(p.amount_paid)
                            FROM payment p
                            WHERE p.invoice_id = i.invoice_id
                        ), 0
                    ), 0
                )
            ), 0
        ) AS balance
        FROM invoice i
        WHERE i.patient_id = $1
        `,
        [patientId]
    );

    res.json({
        upcomingAppointments: appointments.rows[0].total,
        pendingForms: forms.rows[0].total,
        outstandingBalance: billing.rows[0].balance
    });
});
