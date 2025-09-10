// loan-server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const DB_FILE = path.join(__dirname, 'loan.json');
const adapter = new FileSync(DB_FILE);
const db = low(adapter);

// default structure
db.defaults({ loans: [] }).write();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Nodemailer (use your Gmail + app password)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'deepakkhimavath@gmail.com',   // your gmail
    pass: 'grnz atiu ujqk gsti'            // replace with your app password (no spaces)
  }
});

// --- Helpers
function findLoanById(id) {
  return db.get('loans').find({ id }).value();
}

// --- Routes

// Get all loans
app.get('/loans', (req, res) => {
  res.json(db.get('loans').value());
});

// Get single loan by id
app.get('/loans/:id', (req, res) => {
  const loan = findLoanById(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  res.json(loan);
});

// Get loans by userId (user-facing)
app.get('/loans/user/:userId', (req, res) => {
  // userId might be numeric or string in stored data; compare loosely
  const loans = db.get('loans').filter(l => String(l.userId) === String(req.params.userId)).value();
  res.json(loans);
});

// Add new loan
app.post('/loans', (req, res) => {
  const body = req.body;

  // expected fields: loanId, userId, applicantName, applicantEmail, type, amount, tenureYears (number), purpose, documents, status
  // Accept existing formats too (tenure might be a string)
  const tenureYears = body.tenureYears ?? (typeof body.tenure === 'string' && body.tenure.match(/\d+/) ? parseInt(body.tenure.match(/\d+/)[0], 10) : 1);

  // repayment option: 'emi' or 'full'
  const paymentOption = body.paymentOption || 'emi';

  const months = paymentOption === 'full' ? 1 : (body.repaymentMonths ?? tenureYears * 12);

  const amount = Number(body.amount) || 0;
  const monthlyInstallment = months > 0 ? Math.ceil(amount / months) : amount;

  const loan = {
    id: uuidv4(),
    loanId: body.loanId ?? Date.now(),
    userId: body.userId,
    applicantName: body.applicantName,
    applicantEmail: body.applicantEmail || body.email || null,
    type: body.type || body.loanType || 'Loan',
    amount: amount,
    tenureYears: tenureYears,
    repaymentMonths: months,
    paymentOption,
    monthlyInstallment,
    totalPaid: 0,
    repayments: [], // { id, date, amount, type }
    purpose: body.purpose || '',
    documents: body.documents || [],
    status: body.status || 'Pending',
    createdAt: new Date().toISOString()
  };

  db.get('loans').push(loan).write();
  res.status(201).json(loan);
});

// Update loan (partial)
app.patch('/loans/:id', (req, res) => {
  const id = req.params.id;
  const existing = findLoanById(id);
  if (!existing) return res.status(404).json({ error: 'Loan not found' });

  // allow partial update
  db.get('loans').find({ id }).assign(req.body).write();
  const updated = findLoanById(id);

  // If status changed to Approved/Rejected/Withdrawn -> send email (if email exists)
  if (req.body.status) {
    const targetEmail = updated.applicantEmail;
    if (targetEmail) {
      let subject = '';
      let html = '';

      const typeLabel = updated.type || 'Loan';
      if (req.body.status === 'Approved') {
        subject = `🎉 Your ${typeLabel} (ID: ${updated.loanId}) is Approved`;
        html = `
          <div style="font-family:Inter,Arial,sans-serif;max-width:680px;margin:auto;padding:18px;background:#f7f8fb;border-radius:10px;">
            <div style="background:linear-gradient(90deg,#4caf50,#2ecc71);padding:18px;border-radius:8px;color:white;text-align:center;">
              <h1 style="margin:0;font-size:22px;">Congratulations!</h1>
              <p style="margin:6px 0 0;">Your ${typeLabel} has been <strong>APPROVED</strong></p>
            </div>
            <div style="padding:18px;background:white;border-radius:8px;margin-top:12px;">
              <p>Hi <strong>${updated.applicantName}</strong>,</p>
              <p>We’re happy to let you know your <strong>${typeLabel}</strong> has been approved.</p>
              <ul>
                <li><strong>Loan ID:</strong> ${updated.loanId}</li>
                <li><strong>Loan Type:</strong> ${typeLabel}</li>
                <li><strong>Amount:</strong> ₹${updated.amount}</li>
                <li><strong>Tenure:</strong> ${updated.tenureYears ?? ''} year(s) (${updated.repaymentMonths} months)</li>
                <li><strong>Monthly Installment:</strong> ₹${updated.monthlyInstallment}</li>
              </ul>
              <p style="margin-top:14px;">Thank you for choosing us. If you have any questions, reply to this mail.</p>
              <p style="color:#666;font-size:13px;margin-top:14px;">Regards,<br/>Loan Team</p>
            </div>
          </div>
        `;
      } else if (req.body.status === 'Rejected') {
        subject = `❌ Update on your ${typeLabel} (ID: ${updated.loanId})`;
        html = `
          <div style="font-family:Inter,Arial,sans-serif;max-width:680px;margin:auto;padding:18px;background:#fff6f6;border-radius:10px;">
            <div style="background:linear-gradient(90deg,#ff6b6b,#ff4d4f);padding:18px;border-radius:8px;color:white;text-align:center;">
              <h1 style="margin:0;font-size:22px;">Loan Application Update</h1>
            </div>
            <div style="padding:18px;background:white;border-radius:8px;margin-top:12px;">
              <p>Hi <strong>${updated.applicantName}</strong>,</p>
              <p>We regret to inform you that your <strong>${typeLabel}</strong> request (Loan ID: ${updated.loanId}) has been <strong style="color:#c0392b;">rejected</strong>.</p>
              <p>This could be due to eligibility or documentation. You may reapply after reviewing the eligibility requirements.</p>
              <p style="color:#666;font-size:13px;margin-top:14px;">Regards,<br/>Loan Team</p>
            </div>
          </div>
        `;
      } else if (req.body.status === 'Withdrawn') {
        subject = `ℹ️ Your ${typeLabel} (ID: ${updated.loanId}) has been withdrawn`;
        html = `
          <div style="font-family:Inter,Arial,sans-serif;max-width:680px;margin:auto;padding:18px;background:#eef7ff;border-radius:10px;">
            <div style="background:linear-gradient(90deg,#2196f3,#00a1ff);padding:18px;border-radius:8px;color:white;text-align:center;">
              <h1 style="margin:0;font-size:22px;">Loan Withdrawn</h1>
            </div>
            <div style="padding:18px;background:white;border-radius:8px;margin-top:12px;">
              <p>Hi <strong>${updated.applicantName}</strong>,</p>
              <p>Your request has been marked as <strong>withdrawn</strong>. If you change your mind you can submit a new application anytime.</p>
              <p style="color:#666;font-size:13px;margin-top:14px;">Regards,<br/>Loan Team</p>
            </div>
          </div>
        `;
      }

      if (subject && html) {
        transporter.sendMail({ from: 'Loan Team <no-reply@loanapp.local>', to: targetEmail, subject, html }, (err, info) => {
          if (err) console.error('Mail error:', err);
          else console.log('Mail sent:', info.response);
        });
      }
    }
  }

  res.json(updated);
});

// Pay endpoint: record a payment (monthly or full)
app.post('/loans/:id/pay', (req, res) => {
  const { amount, type } = req.body; // type: 'monthly' | 'full' | 'custom'
  const id = req.params.id;
  const loan = findLoanById(id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });

  const payAmount = amount ? Number(amount) : (type === 'full' ? Number(loan.amount - (loan.totalPaid || 0)) : Number(loan.monthlyInstallment || 0));
  const paymentRecord = {
    id: uuidv4(),
    date: new Date().toISOString(),
    amount: payAmount,
    type: type || 'monthly'
  };

  // update fields
  db.get('loans').find({ id }).get('repayments').push(paymentRecord).write();
  db.get('loans').find({ id }).update('totalPaid', n => (Number(n || 0) + payAmount)).write();

  const updated = findLoanById(id);
  // if fully paid -> mark as 'Closed'
  if (Number(updated.totalPaid) >= Number(updated.amount)) {
    db.get('loans').find({ id }).assign({ status: 'Closed' }).write();
  }

  // send payment receipt email if applicantEmail present
  if (updated.applicantEmail) {
    const subject = `Payment received for Loan ${updated.loanId}`;
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:680px;margin:auto;padding:18px;background:#f4fff6;border-radius:10px;">
        <div style="padding:14px;border-radius:8px;background:white;">
          <p>Hi <strong>${updated.applicantName}</strong>,</p>
          <p>We received a payment of <strong>₹${payAmount}</strong> for your <strong>${updated.type}</strong> (Loan ID: ${updated.loanId}).</p>
          <p><strong>Total Paid:</strong> ₹${updated.totalPaid} / ₹${updated.amount}</p>
          <p>Status: <strong>${updated.status}</strong></p>
          <p style="color:#666;font-size:13px;margin-top:14px;">Regards,<br/>Loan Team</p>
        </div>
      </div>
    `;
    transporter.sendMail({ from: 'Loan Team <no-reply@loanapp.local>', to: updated.applicantEmail, subject, html }, (err, info) => {
      if (err) console.error('Payment mail error:', err);
      else console.log('Payment mail sent:', info.response);
    });
  }

  res.json(findLoanById(id));
});

// Delete loan
app.delete('/loans/:id', (req, res) => {
  db.get('loans').remove({ id: req.params.id }).write();
  res.status(204).send();
});

// Start
const PORT = 3001;
app.listen(PORT, () => console.log(`🚀 Loan API running on http://localhost:${PORT}`));
