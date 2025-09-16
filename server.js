require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const Joi = require('joi');
const nodemailer = require('nodemailer');
const cors = require('cors');
const paypal = require('@paypal/checkout-server-sdk');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // Adjust for production

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Models
const contactSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: String,
  phone: String,
  subject: String,
  message: String,
  date: { type: Date, default: Date.now }
});
const Contact = mongoose.model('Contact', contactSchema);

const volunteerSchema = new mongoose.Schema({
  fullName: String,
  email: String,
  phone: String,
  preferredArea: String,
  skills: String,
  availability: [String],
  date: { type: Date, default: Date.now }
});
const Volunteer = mongoose.model('Volunteer', volunteerSchema);

const donationSchema = new mongoose.Schema({
  fullName: String,
  email: String,
  phone: String,
  country: String,
  amount: Number,
  type: String, // one-time or monthly
  method: String, // chapa, paypal, bank
  status: { type: String, default: 'pending' },
  txRef: String, // For Chapa or PayPal order ID
  date: { type: Date, default: Date.now }
});
const Donation = mongoose.model('Donation', donationSchema);

const subscriberSchema = new mongoose.Schema({
  email: String,
  date: { type: Date, default: Date.now }
});
const Subscriber = mongoose.model('Subscriber', subscriberSchema);

// Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// PayPal Client
function paypalClient() {
  const environment = new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET); // Change to LiveEnvironment for production
  return new paypal.core.PayPalHttpClient(environment);
}

// Validation Schemas
const contactSchemaJoi = Joi.object({
  firstName: Joi.string().required(),
  lastName: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string().optional(),
  subject: Joi.string().required(),
  message: Joi.string().required()
});

const volunteerSchemaJoi = Joi.object({
  fullName: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string().optional(),
  preferredArea: Joi.string().required(),
  skills: Joi.string().optional(),
  availability: Joi.array().items(Joi.string()).optional()
});

const donationSchemaJoi = Joi.object({
  fullName: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string().optional(),
  country: Joi.string().optional(),
  amount: Joi.number().min(1).required(),
  type: Joi.string().valid('one-time', 'monthly').required(),
  method: Joi.string().valid('chapa', 'paypal', 'bank').required()
});

const subscriberSchemaJoi = Joi.object({
  email: Joi.string().email().required()
});

// Endpoints

// Contact Form
app.post('/api/contact', async (req, res, next) => {
  try {
    const { error } = contactSchemaJoi.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const contact = new Contact(req.body);
    await contact.save();

    // Send email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: 'kuraagalaan2024@gmail.com',
      subject: `New Contact: ${req.body.subject}`,
      text: `From: ${req.body.firstName} ${req.body.lastName}\nEmail: ${req.body.email}\nPhone: ${req.body.phone}\nMessage: ${req.body.message}`
    });

    res.status(201).json({ message: 'Contact submitted successfully' });
  } catch (err) {
    next(err);
  }
});

// Volunteer Form
app.post('/api/volunteer', async (req, res, next) => {
  try {
    const { error } = volunteerSchemaJoi.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const volunteer = new Volunteer(req.body);
    await volunteer.save();

    // Send email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: 'kuraagalaan2024@gmail.com',
      subject: 'New Volunteer Application',
      text: `Name: ${req.body.fullName}\nEmail: ${req.body.email}\nPhone: ${req.body.phone}\nArea: ${req.body.preferredArea}\nSkills: ${req.body.skills}\nAvailability: ${req.body.availability.join(', ')}`
    });

    res.status(201).json({ message: 'Volunteer application submitted' });
  } catch (err) {
    next(err);
  }
});

// Donation Form
app.post('/api/donate', async (req, res, next) => {
  try {
    const { error } = donationSchemaJoi.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const donation = new Donation(req.body);

    if (req.body.method === 'bank') {
      donation.status = 'intent';
      await donation.save();
      // Send email with bank details
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: req.body.email,
        subject: 'Thank you for your donation intent',
        text: 'Bank details: Commercial Bank of Ethiopia, Account: 1000123456789, Swift: CBETETAA. Please send receipt to kuraagalaan2024@gmail.com'
      });
      res.json({ message: 'Donation intent recorded. Please complete bank transfer.' });
    } else if (req.body.method === 'chapa') {
      // Initiate Chapa payment (assume type=telebirr; adjust based on frontend)
      const txRef = `KG-${Date.now()}`;
      donation.txRef = txRef;
      const boundary = '--------------------------' + Date.now().toString(16);
      const dataList = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="amount"',
        '',
        req.body.amount.toString(),
        `--${boundary}`,
        'Content-Disposition: form-data; name="currency"',
        '',
        'ETB',
        `--${boundary}`,
        'Content-Disposition: form-data; name="tx_ref"',
        '',
        txRef,
        `--${boundary}`,
        'Content-Disposition: form-data; name="mobile"',
        '',
        req.body.phone || 'default_phone', // Require phone for Chapa
        `--${boundary}--`,
        ''
      ];
      const payload = dataList.join('\r\n');

      const response = await axios.post(
        'https://api.chapa.co/v1/charges?type=telebirr', // Adjust type
        payload,
        {
          headers: {
            'Authorization': `Bearer ${process.env.CHAPA_SECRET_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          }
        }
      );

      donation.status = 'initiated';
      await donation.save();

      // Send email
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: 'kuraagalaan2024@gmail.com',
        subject: 'New Donation Initiated (Chapa)',
        text: `Amount: ${req.body.amount} ETB\nFrom: ${req.body.fullName}\nTx Ref: ${txRef}`
      });

      res.json({ message: 'Payment initiated', data: response.data });
    } else if (req.body.method === 'paypal') {
      const client = paypalClient();
      const request = new paypal.orders.OrdersCreateRequest();
      request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD', // Adjust if needed
            value: req.body.amount.toString()
          },
          description: 'Donation to Kuraa Galaan Charity'
        }]
      });

      const response = await client.execute(request);
      donation.txRef = response.result.id;
      donation.status = 'created';
      await donation.save();

      // Find approve link
      const approveLink = response.result.links.find(link => link.rel === 'approve')?.href;

      // Send email
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: 'kuraagalaan2024@gmail.com',
        subject: 'New Donation Initiated (PayPal)',
        text: `Amount: ${req.body.amount} USD\nFrom: ${req.body.fullName}\nOrder ID: ${response.result.id}`
      });

      res.json({ message: 'PayPal order created', approveUrl: approveLink });
    }
  } catch (err) {
    next(err);
  }
});

// PayPal Capture (Call after approval, e.g., from webhook or callback)
app.post('/api/donate/paypal/capture/:orderId', async (req, res, next) => {
  try {
    const client = paypalClient();
    const request = new paypal.orders.OrdersCaptureRequest(req.params.orderId);
    request.requestBody({});

    const response = await client.execute(request);
    if (response.result.status === 'COMPLETED') {
      await Donation.updateOne({ txRef: req.params.orderId }, { status: 'completed' });
      res.json({ message: 'Payment captured' });
    } else {
      res.status(400).json({ error: 'Capture failed' });
    }
  } catch (err) {
    next(err);
  }
});

// Chapa Verify (Call after payment)
app.get('/api/donate/chapa/verify/:txRef', async (req, res, next) => {
  try {
    // Assuming verify endpoint is https://api.chapa.co/v1/transaction/verify/{tx_ref}
    const response = await axios.get(`https://api.chapa.co/v1/transaction/verify/${req.params.txRef}`, {
      headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` }
    });

    if (response.data.status === 'success') {
      await Donation.updateOne({ txRef: req.params.txRef }, { status: 'completed' });
      res.json({ message: 'Payment verified' });
    } else {
      res.status(400).json({ error: 'Verification failed' });
    }
  } catch (err) {
    next(err);
  }
});

// Newsletter Subscription
app.post('/api/subscribe', async (req, res, next) => {
  try {
    const { error } = subscriberSchemaJoi.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const subscriber = new Subscriber(req.body);
    await subscriber.save();

    // Send welcome email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: req.body.email,
      subject: 'Welcome to Kuraa Galaan Newsletter',
      text: 'Thank you for subscribing! Stay tuned for updates.'
    });

    res.status(201).json({ message: 'Subscribed successfully' });
  } catch (err) {
    next(err);
  }
});

// Error Handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
