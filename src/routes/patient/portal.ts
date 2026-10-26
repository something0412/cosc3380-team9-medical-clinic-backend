import { Router } from "express";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { getOutstandingBalance, getPatientBilling } from "../../services/billing.js";
import { listAppointments } from "../../services/booking.js";

export const patientPortalRouter = Router();

// the same appointment list the staff see, with the date and time names this page already uses
patientPortalRouter.get("/api/patient/:id/appointments", async (req, res) => {
    const appointments = await listAppointments({ patientId: Number(req.params.id) }, { when: "all" });
    res.json(appointments.map((a) => ({ ...a, appointmentDate: a.date, appointmentTime: a.startTime })));
});


patientPortalRouter.get("/api/patient/:id/forms", async (req, res) => {
    const patientId = Number(req.params.id);

    const result = await pool.query(
        `-- TODO P14: forms: every active form with my latest submission`,
        [patientId]
    );

    res.json(result.rows);
});


// invoices with what's been paid and what's left, plus the same balance the Admin sees
patientPortalRouter.get("/api/patient/:id/billing", async (req, res) => {
    res.json(await getPatientBilling(Number(req.params.id)));
});


patientPortalRouter.get("/api/patient/:id/records", async (req, res) => {
    const patientId = Number(req.params.id);

    const visits = await pool.query(
        `-- TODO P11: records: my visits with a visit summary`,
        [patientId]
    );

    const prescriptions = await pool.query(
        `-- TODO P12: records: my prescription lines`,
        [patientId]
    );

    const labResults = await pool.query(
        `-- TODO P13: records: my lab orders`,
        [patientId]
    );

    res.json({
        visits: visits.rows,
        prescriptions: prescriptions.rows,
        labResults: labResults.rows
    });
});


patientPortalRouter.get("/api/patient/:id/dashboard", async (req, res) => {
    const patientId = Number(req.params.id);

    const appointments = await pool.query(
        `-- TODO P01: dashboard: count my upcoming appointments`,
        [patientId]
    );

    const forms = await pool.query(
        `-- TODO P02: dashboard: count required forms I haven't completed`,
        [patientId]
    );

    res.json({
        upcomingAppointments: appointments.rows[0].total,
        pendingForms: forms.rows[0].total,
        outstandingBalance: await getOutstandingBalance(patientId)
    });
});
