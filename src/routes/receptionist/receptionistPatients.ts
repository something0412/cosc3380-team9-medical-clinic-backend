import { Router } from "express";
import { pool } from "../../lib/db.js";

export const receptionistPatientsRouter = Router();

// get the front desk view of one patient
receptionistPatientsRouter.get("/api/receptionist/patients/:id", async (req, res) => {
  const patientId = Number(req.params.id);

  if (!patientId) {
    res.status(400).json({ error: "Invalid patient" });
    return;
  }

  // get the patient's basic info and whether they have a login
  const patient = await pool.query(
    ``,
    [patientId]
  );
  if (patient.rowCount === 0) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }

  // get the patient's insurance
  const insurance = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's active emergency contacts, primary first
  const emergencyContacts = await pool.query(
    ``,
    [patientId]
  );

  // get every active form and whether the patient completed it
  const forms = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's 10 newest appointments at any office
  const appointments = await pool.query(
    ``,
    [patientId]
  );

  // get what the patient still owes on all unpaid invoices
  const balance = await pool.query(
    ``,
    [patientId]
  );

  res.json({
    ...patient.rows[0],
    insurance: insurance.rows[0] ?? null,
    emergencyContacts: emergencyContacts.rows,
    forms: forms.rows,
    appointments: appointments.rows,
    balance: balance.rows[0].balance,
  });
});

// update the patient's contact info (email is their login, so it stays)
receptionistPatientsRouter.patch("/api/receptionist/patients/:id", async (req, res) => {
  const patientId = Number(req.params.id);
  const phone = String(req.body.phone ?? "").trim();
  const address = String(req.body.address ?? "").trim();
  const gender = String(req.body.gender ?? "").trim();

  if (!phone) {
    res.status(400).json({ error: "Phone is required" });
    return;
  }

  // save the patient's phone, address and gender (empty saved as null)
  const result = await pool.query(
    ``,
    [phone, address || null, gender || null, patientId]
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }

  res.json(result.rows[0]);
});

// add or change the patient's insurance (it goes back to Pending)
receptionistPatientsRouter.put("/api/receptionist/patients/:id/insurance", async (req, res) => {
  const patientId = Number(req.params.id);
  const provider = String(req.body.provider ?? "").trim();
  const policyNumber = String(req.body.policyNumber ?? "").trim();

  if (!provider || !policyNumber) {
    res.status(400).json({ error: "Provider and policy number are required" });
    return;
  }

  // check no other patient has this policy number
  const taken = await pool.query(
    ``,
    [policyNumber, patientId]
  );
  if (taken.rowCount !== 0) {
    res.status(409).json({ error: "This policy number belongs to another patient" });
    return;
  }

  // add the insurance, or replace the one the patient has, as Pending
  const result = await pool.query(
    ``,
    [patientId, provider, policyNumber]
  );

  res.json(result.rows[0]);
});

// verify or deny the patient's insurance
receptionistPatientsRouter.patch("/api/receptionist/patients/:id/insurance/status", async (req, res) => {
  const patientId = Number(req.params.id);
  const status = req.body.status;

  if (status !== "Verified" && status !== "Denied") {
    res.status(400).json({ error: "Status must be Verified or Denied" });
    return;
  }

  // save the patient's insurance status
  const result = await pool.query(
    ``,
    [status, patientId]
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "This patient has no insurance on file" });
    return;
  }

  res.json(result.rows[0]);
});

// add an emergency contact
receptionistPatientsRouter.post("/api/receptionist/patients/:id/emergency-contacts", async (req, res) => {
  const patientId = Number(req.params.id);
  const firstName = String(req.body.firstName ?? "").trim();
  const lastName = String(req.body.lastName ?? "").trim();
  const relationship = String(req.body.relationship ?? "").trim();
  const phoneNumber = String(req.body.phoneNumber ?? "").trim();
  const isPrimary = req.body.isPrimary === true;

  if (!firstName || !lastName || !relationship || !phoneNumber) {
    res.status(400).json({ error: "Name, relationship and phone are required" });
    return;
  }

  // save the contact and the primary flag together
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (isPrimary) {
      // take primary off the patient's other contacts
      await client.query(
        ``,
        [patientId]
      );
    }

    // add the emergency contact
    const result = await client.query(
      ``,
      [patientId, firstName, lastName, relationship, phoneNumber, isPrimary]
    );

    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// mark a paper form the patient signed at the desk as completed
receptionistPatientsRouter.post("/api/receptionist/patients/:id/forms/:formTypeId/complete", async (req, res) => {
  const patientId = Number(req.params.id);
  const formTypeId = Number(req.params.formTypeId);

  // check the patient hasn't completed this form already
  const done = await pool.query(
    ``,
    [patientId, formTypeId]
  );
  if (done.rowCount !== 0) {
    res.status(400).json({ error: "This form is already completed" });
    return;
  }

  // save a completed submission dated today (only for an active form)
  const result = await pool.query(
    ``,
    [patientId, formTypeId]
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Form not found" });
    return;
  }

  res.status(201).json(result.rows[0]);
});
