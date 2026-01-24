const express = require('express');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
}));
app.use(express.json());

// Raw body for webhook signature verification
app.use('/api/webhooks/stripe', express.raw({type: 'application/json'}));

// ============================================
// Google Sheets Setup
// ============================================

let googleCredentials;
try {
  // Try to parse as JSON object (from .env file)
  googleCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  console.log('✓ Google credentials parsed as JSON');
} catch (e) {
  console.log('⚠ Could not parse as JSON, treating as raw key');
  googleCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
}

const privateKey = typeof googleCredentials === 'object' ? googleCredentials.private_key : googleCredentials;

if (!privateKey) {
  throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY or private_key is missing!');
}

console.log('Private key starts with:', privateKey.substring(0, 50));
console.log('Private key ends with:', privateKey.substring(privateKey.length - 50));

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: privateKey,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_ID, serviceAccountAuth);

async function addToGoogleSheets(data, sheetIndex = 0) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[sheetIndex];
    
    await sheet.addRow({
      order_reference: data.order_reference,
      customer_name: data.customer_name,
      customer_email: data.customer_email,
      customer_phone: data.customer_phone || '',
      quantity: data.quantity || 1,
      amount_total: data.amount_total,
      stripe_session_id: data.stripe_session_id || '',
      stripe_payment_intent_id: data.stripe_payment_intent_id || '',
      status: data.status,
      product_type: data.product_type || 'ticket', // 'ticket' or 'book'
      shipping_address: data.shipping_address || '',
      shipping_city: data.shipping_city || '',
      shipping_postcode: data.shipping_postcode || '',
      created_at: data.created_at,
      updated_at: data.updated_at,
    });
  } catch (error) {
    console.error('Error adding to Google Sheets:', error);
    throw error;
  }
}

async function updateGoogleSheets(orderRef, updates, sheetIndex = 0) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[sheetIndex];
    const rows = await sheet.getRows();
    
    const row = rows.find(r => r.order_reference === orderRef);
    if (row) {
      for (const [key, value] of Object.entries(updates)) {
        row[key] = value;
      }
      await row.save();
    }
  } catch (error) {
    console.error('Error updating Google Sheets:', error);
    throw error;
  }
}

async function getFromGoogleSheets(orderRef, sheetIndex = 0) {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[sheetIndex];
    const rows = await sheet.getRows();
    
    const row = rows.find(r => r.order_reference === orderRef);
    return row ? row.toObject() : null;
  } catch (error) {
    console.error('Error reading from Google Sheets:', error);
    throw error;
  }
}

// ============================================
// Email Setup
// ============================================

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD, // Use app-specific password
  },
});

async function sendConfirmationEmail(data, type = 'ticket') {
  try {
    console.log(`📧 Sending ${type} confirmation email to: ${data.email}`);
    let subject, html;
    
    if (type === 'book') {
      subject = `Order Confirmed - Your Book Purchase (${data.orderRef})`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #2d3748; margin-bottom: 20px;">Order Confirmed! 📚</h1>
          
          <p>Hi ${data.name},</p>
          
          <p>Thank you for purchasing "Build Wealth Through Property — 7 Reasons Why". Your order has been confirmed!</p>
          
          <div style="background-color: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Your Order Details</h3>
            <p><strong>Order Reference:</strong> ${data.orderRef}</p>
            <p><strong>Product:</strong> Build Wealth Through Property — 7 Reasons Why</p>
            <p><strong>Shipping Address:</strong> ${data.address}</p>
            <p><strong>City:</strong> ${data.city}</p>
            <p><strong>Postcode:</strong> ${data.postcode}</p>
            <p><strong>Total Amount:</strong> £${(data.amountTotal / 100).toFixed(2)}</p>
          </div>
          
          <div style="background-color: #fef2f2; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ef4444;">
            <p style="margin: 0; color: #991b1b;"><strong>100% of proceeds go to Place of Victory Charity</strong></p>
            <p style="margin: 5px 0 0 0; color: #7f1d1d; font-size: 14px;">Thank you for supporting our charity mission!</p>
          </div>
          
          <h3>What Happens Next?</h3>
          <ul>
            <li>Your book will be shipped to the address provided</li>
            <li>You will receive a shipping confirmation email once your order is dispatched</li>
            <li>Expected delivery: 5-7 business days</li>
          </ul>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;">
          
          <p>If you have any questions, please reply to this email or visit our website.</p>
          
          <p>Best regards,<br>
          The Team</p>
        </div>
      `;
    } else {
      subject = `Booking Confirmed - Your Seminar Tickets (${data.orderRef})`;
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #2d3748; margin-bottom: 20px;">Booking Confirmed! 🎉</h1>
          
          <p>Hi ${data.name},</p>
          
          <p>Thank you for booking your tickets to our seminar. Your booking has been confirmed!</p>
          
          <div style="background-color: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Your Booking Details</h3>
            <p><strong>Order Reference:</strong> ${data.orderRef}</p>
            <p><strong>Number of Tickets:</strong> ${data.quantity}</p>
            <p><strong>Event Date:</strong> Friday, 14 March 2026</p>
            <p><strong>Time:</strong> 2:00 PM – 4:00 PM (Doors open 1:15 PM)</p>
            <p><strong>Location:</strong> Whitla Hall, Methodist College Belfast</p>
          </div>
          
          <h3>What Happens Next?</h3>
          <ul>
            <li>Please bring this email or your order reference to the event for check-in</li>
            <li>Arrive early to secure your preferred seating</li>
            <li>Check the website for any updates before the event</li>
          </ul>
          
          <h3>Can't Make It?</h3>
          <p>Tickets are non-refundable but transferable. If you can't attend, you can transfer your tickets to someone else.</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;">
          
          <p>If you have any questions, please reply to this email or visit our website.</p>
          
          <p>Best regards,<br>
          The Seminar Team</p>
        </div>
      `;
    }
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: data.email,
      subject: subject,
      html: html,
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`Confirmation email sent to ${data.email}`);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// ============================================
// API Endpoints
// ============================================

/**
 * Create Stripe Checkout Session
 */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { name, email, phone, quantity, ticketPrice, successUrl, cancelUrl } = req.body;

    // Validate input
    if (!name || !email || !quantity || !ticketPrice) {
      return res.status(400).json({
        error: 'Missing required fields: name, email, quantity, ticketPrice',
      });
    }

    // Generate order reference
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substr(2, 9).toUpperCase();
    const orderRef = `ORDER-${timestamp}-${randomId}`;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Seminar Tickets',
              description: `${quantity} ticket(s) for Friday, 14 March 2026`,
            },
            unit_amount: Math.round(ticketPrice * 100), // Amount in pence
          },
          quantity: quantity,
        },
      ],
      mode: 'payment',
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}&order_ref=${orderRef}&payment=success`,
      cancel_url: `${cancelUrl}?payment=cancelled`,
      customer_email: email,
      metadata: {
        orderRef,
        name,
        phone: phone || '',
        quantity,
      },
    });

    // Add initial record to Google Sheets with "pending" status
    await addToGoogleSheets({
      order_reference: orderRef,
      customer_name: name,
      customer_email: email,
      customer_phone: phone || '',
      quantity: quantity,
      amount_total: ticketPrice * quantity,
      stripe_session_id: session.id,
      status: 'pending',
      product_type: 'ticket',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    res.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({
      error: error.message || 'Failed to create checkout session',
    });
  }
});

/**
 * Create Stripe Checkout Session for Book Purchase
 */
app.post('/api/create-book-checkout-session', async (req, res) => {
  try {
    const { name, email, phone, address, city, postcode, bookPrice, shippingPrice, successUrl, cancelUrl } = req.body;

    // Validate input
    if (!name || !email || !address || !city || !postcode || !bookPrice || !shippingPrice) {
      return res.status(400).json({
        error: 'Missing required fields: name, email, address, city, postcode, bookPrice, shippingPrice',
      });
    }

    // Generate order reference
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substr(2, 9).toUpperCase();
    const orderRef = `BOOK-${timestamp}-${randomId}`;

    const totalAmount = bookPrice + shippingPrice;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Build Wealth Through Property — 7 Reasons Why',
              description: 'Physical book with UK shipping',
            },
            unit_amount: Math.round(bookPrice * 100), // Amount in pence
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'UK Shipping',
              description: 'Shipping within UK',
            },
            unit_amount: Math.round(shippingPrice * 100), // Amount in pence
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}&order_ref=${orderRef}&payment=success`,
      cancel_url: `${cancelUrl}?payment=cancelled`,
      customer_email: email,
      shipping_address_collection: {
        allowed_countries: ['GB'],
      },
      metadata: {
        orderRef,
        name,
        phone: phone || '',
        address,
        city,
        postcode,
        productType: 'book',
      },
    });

    // Add initial record to Google Sheets with "pending" status
    await addToGoogleSheets({
      order_reference: orderRef,
      customer_name: name,
      customer_email: email,
      customer_phone: phone || '',
      quantity: 1,
      amount_total: totalAmount,
      stripe_session_id: session.id,
      status: 'pending',
      product_type: 'book',
      shipping_address: address,
      shipping_city: city,
      shipping_postcode: postcode,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    res.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    console.error('Error creating book checkout session:', error);
    res.status(500).json({
      error: error.message || 'Failed to create checkout session',
    });
  }
});

/**
 * Verify Payment Session
 */
app.get('/api/verify-session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    res.json({
      sessionId: session.id,
      status: session.payment_status,
      amountTotal: session.amount_total,
      customerEmail: session.customer_email,
      metadata: session.metadata,
    });
  } catch (error) {
    console.error('Error verifying session:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Ticket Purchase
 */
app.get('/api/tickets/:orderReference', async (req, res) => {
  try {
    const { orderReference } = req.params;

    const ticket = await getFromGoogleSheets(orderReference);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json(ticket);
  } catch (error) {
    console.error('Error fetching ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Add Ticket Purchase
 */
app.post('/api/tickets', async (req, res) => {
  try {
    const data = req.body;

    await addToGoogleSheets(data);

    res.json({ success: true, order_reference: data.order_reference });
  } catch (error) {
    console.error('Error adding ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update Ticket Purchase
 */
app.patch('/api/tickets/:orderReference', async (req, res) => {
  try {
    const { orderReference } = req.params;
    const updates = req.body;

    await updateGoogleSheets(orderReference, updates);

    const updated = await getFromGoogleSheets(orderReference);

    res.json(updated);
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Stripe Webhook Handler
 */
app.post('/api/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  console.log('🔔 Stripe webhook received');

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('✓ Webhook signature verified, event type:', event.type);
  } catch (err) {
    console.error('❌ Webhook error:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        const productType = session.metadata.productType || 'ticket';
        
        console.log(`✓ Payment completed for ${productType} order ${session.metadata.orderRef}`);
        
        // Update Google Sheets with completed status
        await updateGoogleSheets(session.metadata.orderRef, {
          status: 'completed',
          stripe_payment_intent_id: session.payment_intent,
          updated_at: new Date().toISOString(),
        });

        // Send confirmation email based on product type
        if (productType === 'book') {
          await sendConfirmationEmail({
            email: session.customer_email,
            name: session.metadata.name,
            orderRef: session.metadata.orderRef,
            address: session.metadata.address,
            city: session.metadata.city,
            postcode: session.metadata.postcode,
            amountTotal: session.amount_total,
          }, 'book');
        } else {
          await sendConfirmationEmail({
            email: session.customer_email,
            name: session.metadata.name,
            orderRef: session.metadata.orderRef,
            quantity: session.metadata.quantity,
          }, 'ticket');
        }

        console.log(`✓ Confirmation email queued for ${session.customer_email}`);
        break;

      case 'checkout.session.expired':
        const expiredSession = event.data.object;
        
        console.log(`⚠ Checkout expired for order ${expiredSession.metadata.orderRef}`);
        
        // Update status to failed
        await updateGoogleSheets(expiredSession.metadata.orderRef, {
          status: 'failed',
          updated_at: new Date().toISOString(),
        });

        break;

      default:
        console.log(`ℹ Unhandled event type ${event.type}`);
    }

    res.json({received: true});
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Health Check
 */
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// ============================================
// Start Server
// ============================================

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;