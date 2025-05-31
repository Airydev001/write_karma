import express from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import cors from 'cors';
import bodyParser from 'body-parser';
import admin from 'firebase-admin';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors());

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      if (req.originalUrl === '/webhook') {
        req.rawBody = buf.toString();
      }
    },
  })
);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

app.post('/create-checkout-session', async (req, res) => {
  const { priceId, successUrl, cancelUrl, firestoreDocId } = req.body;
  if (!priceId || !successUrl || !cancelUrl || !firestoreDocId)
    return res.status(400).json({ error: 'Missing parameters' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { firestoreDocId },
    });
    res.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook signature verification failed.', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const firestoreDocId = session.metadata.firestoreDocId;

      try {
        await db.collection('users').doc(firestoreDocId).update({
          isPaid: true,
          paymentId: session.payment_intent,
          paymentStatus: session.payment_status,
          paymentAmount: session.amount_total,
          currency: session.currency,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Updated Firestore doc ${firestoreDocId} with payment info.`);
      } catch (err) {
        console.error('Firestore update failed:', err);
        return res.status(500).send();
      }
    }

    res.json({ received: true });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
