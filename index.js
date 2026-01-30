const express = require('express');
require('dotenv').config();

const nodemailer = require('nodemailer');
const cors = require('cors');

// Verify critical environment variables are loaded
const requiredEnvVars = ['STRIPE_SECRET_KEY', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_SHEETS_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'EMAIL_USER', 'EMAIL_PASSWORD'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing environment variables:', missingEnvVars.join(', '));
  if (process.env.NODE_ENV === 'production') {
    console.error('Make sure these are set in your Vercel/hosting environment variables');
  }
}

// Lazy-load Stripe
let stripe = null;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

const app = express();

// Middleware
app.use(cors({
  // In development allow any origin (reflect request origin). In production set FRONTEND_URL.
  origin: process.env.FRONTEND_URL || true,
}));

// Raw body for webhook signature verification MUST be registered before express.json()
// so Stripe's signature verification receives the raw payload unchanged.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(express.json());

// ============================================
// Google Sheets Setup (Lazy Initialization)
// ============================================

let googleSheetAuthInitialized = false;
let doc;
let GoogleSpreadsheet; // Store the class reference

async function initializeGoogleSheets() {
  if (googleSheetAuthInitialized) {
    console.log('✓ Google Sheets already initialized');
    return;
  }
  
  console.log('🔄 Initializing Google Sheets...');
  
  try {
    // Check required environment variables first
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL is not set');
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
    }
    if (!process.env.GOOGLE_SHEETS_ID) {
      throw new Error('GOOGLE_SHEETS_ID is not set');
    }
    
    // Lazy load google-spreadsheet only when needed
    if (!GoogleSpreadsheet) {
      const module = require('google-spreadsheet');
      GoogleSpreadsheet = module.GoogleSpreadsheet;
      console.log('✓ Google Spreadsheet module loaded');
    }
    
    let googleCredentials;
    try {
      googleCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      console.log('✓ Google credentials parsed as JSON');
    } catch (e) {
      console.log('⚠ Could not parse GOOGLE_SERVICE_ACCOUNT_KEY as JSON, treating as raw key');
      googleCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    }

    const privateKey = typeof googleCredentials === 'object' ? googleCredentials.private_key : googleCredentials;

    if (!privateKey) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY or private_key is missing or invalid!');
    }

    console.log('✓ Private key extracted');
    console.log('✓ Using service account:', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);

    // Create the document instance (v3.x style)
    doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_ID);
    console.log('✓ Google Spreadsheet instance created with ID:', process.env.GOOGLE_SHEETS_ID);
    
    // Authenticate using service account (v3.x style)
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: privateKey,
    });
    console.log('✓ Service account authentication completed');
    
    // Load the document info to verify auth works
    await doc.loadInfo();
    console.log('✓ Successfully loaded spreadsheet:', doc.title);
    
    googleSheetAuthInitialized = true;
    console.log('✅ Google Sheets fully initialized and authenticated');
  } catch (error) {
    console.error('❌ Error initializing Google Sheets:', error.message);
    console.error('Full error:', error);
    googleSheetAuthInitialized = false; // Reset flag on error
    throw error;
  }
}

async function addToGoogleSheets(data, sheetIndex = 0) {
  try {
    await initializeGoogleSheets();
    
    // Reload info to ensure we have the latest sheet data
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[sheetIndex];
    
    if (!sheet) {
      throw new Error(`Sheet at index ${sheetIndex} not found. Available sheets: ${doc.sheetCount}`);
    }
    
    console.log(`Adding row to sheet: ${sheet.title}`);
    
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
    
    console.log('✓ Row added successfully');
  } catch (error) {
    console.error('Error adding to Google Sheets:', error.message);
    throw error;
  }
}

async function updateGoogleSheets(orderRef, updates, sheetIndex = 0) {
  try {
    await initializeGoogleSheets();
    
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[sheetIndex];
    
    if (!sheet) {
      throw new Error(`Sheet at index ${sheetIndex} not found`);
    }
    
    const rows = await sheet.getRows();
    
    const row = rows.find(r => r.get('order_reference') === orderRef);
    if (row) {
      console.log(`Updating row for order ${orderRef}:`, updates);
      for (const [key, value] of Object.entries(updates)) {
        row.set(key, value);
      }
      await row.save();
      console.log(`✓ Successfully updated order ${orderRef}`);
    } else {
      console.warn(`⚠ Order ${orderRef} not found in Google Sheets for update`);
    }
  } catch (error) {
    console.error('Error updating Google Sheets:', error.message);
    throw error;
  }
}

async function getFromGoogleSheets(orderRef, sheetIndex = 0) {
  try {
    await initializeGoogleSheets();
    
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[sheetIndex];
    
    if (!sheet) {
      throw new Error(`Sheet at index ${sheetIndex} not found`);
    }
    
    const rows = await sheet.getRows();
    
    const row = rows.find(r => r.get('order_reference') === orderRef);
    return row ? row.toObject() : null;
  } catch (error) {
    console.error('Error reading from Google Sheets:', error.message);
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
            <p><strong>Quantity:</strong> ${data.quantity || 1} ${(data.quantity || 1) > 1 ? 'books' : 'book'}</p>
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
            <li>Your book${(data.quantity || 1) > 1 ? 's' : ''} will be shipped to the address provided</li>
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
            <p><strong>Event Time:</strong> 6:00 PM - 9:00 PM</p>
            <p><strong>Venue:</strong> Ramada Encore Chatham</p>
          </div>
          
          <h3>What to Bring</h3>
          <ul>
            <li>This confirmation email (digital or printed)</li>
            <li>A valid ID</li>
            <li>Your order reference: <strong>${data.orderRef}</strong></li>
          </ul>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;">
          
          <p>We look forward to seeing you at the seminar!</p>
          
          <p>Best regards,<br>
          The Team</p>
        </div>
      `;
    }

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: data.email,
      subject,
      html,
    });

    console.log(`✓ Email sent successfully to ${data.email}`);
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

// ============================================
// Routes
// ============================================


/**
 * Unified Checkout Session (handles both tickets and books)
 */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { quantity, customerName, customerEmail, customerPhone, productType, address, city, postcode } = req.body;

    if (!quantity || quantity < 1) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    if (!productType || !['ticket', 'book'].includes(productType)) {
      return res.status(400).json({ error: 'Invalid product type. Must be "ticket" or "book"' });
    }

    // Validate shipping info for books
    if (productType === 'book' && (!address || !city || !postcode)) {
      return res.status(400).json({ error: 'Shipping address is required for book orders' });
    }

    const orderRef = productType === 'book' 
      ? `BOOK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      : `TIX-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Product configuration
    const productConfig = productType === 'book' 
      ? {
          name: 'Build Wealth Through Property — 7 Reasons Why',
          description: '100% of proceeds go to Place of Victory Charity',
          unit_amount: 1999, // £19.99
        }
      : {
          name: 'Seminar Ticket',
          description: 'Friday, 14 March 2026 at Ramada Encore Chatham',
          unit_amount: 2500, // £25.00
        };

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: productConfig.name,
              description: productConfig.description,
            },
            unit_amount: productConfig.unit_amount,
          },
          quantity,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}&order_ref=${orderRef}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/cancelled`,
      customer_email: customerEmail,
      metadata: {
        orderRef,
        name: customerName,
        quantity: quantity.toString(),
        phone: customerPhone || '',
        productType,
        ...(productType === 'book' && { address, city, postcode }),
      },
    });

    // Save to Google Sheets with pending status
    await addToGoogleSheets({
      order_reference: orderRef,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone || '',
      quantity,
      amount_total: session.amount_total,
      stripe_session_id: session.id,
      stripe_payment_intent_id: '',
      status: 'pending',
      product_type: productType,
      shipping_address: productType === 'book' ? address : '',
      shipping_city: productType === 'book' ? city : '',
      shipping_postcode: productType === 'book' ? postcode : '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    res.json({
      url: session.url,
      sessionId: session.id,
      orderRef: orderRef,
    });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({
      error: error.message || 'Failed to create checkout session',
    });
  }
});

/**
 * Create Ticket Checkout Session
 */
app.post('/api/create-ticket-checkout-session', async (req, res) => {
  try {
    const { quantity, customerName, customerEmail, customerPhone } = req.body;

    if (!quantity || quantity < 1) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    const orderRef = `TIX-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Seminar Ticket',
              description: 'Friday, 14 March 2026 at Ramada Encore Chatham',
            },
            unit_amount: 2500, // £25.00 in pence
          },
          quantity,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}&order_ref=${orderRef}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/cancelled`,
      customer_email: customerEmail,
      metadata: {
        orderRef,
        name: customerName,
        quantity: quantity.toString(),
        phone: customerPhone || '',
        productType: 'ticket',
      },
    });

    // Save to Google Sheets with pending status
    await addToGoogleSheets({
      order_reference: orderRef,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone || '',
      quantity,
      amount_total: session.amount_total,
      stripe_session_id: session.id,
      stripe_payment_intent_id: '',
      status: 'pending',
      product_type: 'ticket',
      shipping_address: '',
      shipping_city: '',
      shipping_postcode: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    res.json({
      url: session.url,
      sessionId: session.id,
      orderRef: orderRef,
    });
  } catch (error) {
    console.error('Error creating ticket checkout session:', error);
    res.status(500).json({
      error: error.message || 'Failed to create checkout session',
    });
  }
});

/**
 * Create Book Checkout Session
 */
app.post('/api/create-book-checkout-session', async (req, res) => {
  try {
    const { quantity, customerName, customerEmail, customerPhone, address, city, postcode } = req.body;

    if (!quantity || quantity < 1) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    if (!address || !city || !postcode) {
      return res.status(400).json({ error: 'Shipping address is required for book orders' });
    }

    const orderRef = `BOOK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: 'Build Wealth Through Property — 7 Reasons Why',
              description: '100% of proceeds go to Place of Victory Charity',
            },
            unit_amount: 1999, // £19.99 in pence
          },
          quantity,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}&order_ref=${orderRef}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/cancelled`,
      customer_email: customerEmail,
      metadata: {
        orderRef,
        name: customerName,
        quantity: quantity.toString(),
        phone: customerPhone || '',
        address,
        city,
        postcode,
        productType: 'book',
      },
    });

    // Save to Google Sheets with pending status
    await addToGoogleSheets({
      order_reference: orderRef,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone || '',
      quantity,
      amount_total: session.amount_total,
      stripe_session_id: session.id,
      stripe_payment_intent_id: '',
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
      orderRef: orderRef,
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

    const session = await getStripe().checkout.sessions.retrieve(sessionId);

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
    event = getStripe().webhooks.constructEvent(req.body, sig, endpointSecret);
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
        console.log(`Session ID: ${session.id}`);
        console.log(`Session payment intent: ${session.payment_intent}, Payment status: ${session.payment_status}`);
        console.log(`Amount total: ${session.amount_total}`);
        console.log(`Customer email: ${session.customer_email}`);
        console.log(`Metadata:`, session.metadata);
        
        // Retrieve the payment intent to get more details
        let paymentIntentId = session.payment_intent;
        try {
          const paymentIntent = await getStripe().paymentIntents.retrieve(session.payment_intent);
          paymentIntentId = paymentIntent.id;
          console.log(`Payment intent ID: ${paymentIntentId}, status: ${paymentIntent.status}`);
        } catch (piErr) {
          console.warn('Could not retrieve payment intent details:', piErr.message);
        }
        
        // Update Google Sheets with completed status
        await updateGoogleSheets(session.metadata.orderRef, {
          status: 'completed',
          stripe_payment_intent_id: paymentIntentId || session.payment_intent || '',
          updated_at: new Date().toISOString(),
        });

        console.log(`✓ Google Sheets updated for order ${session.metadata.orderRef}`);

        // Send confirmation email based on product type
        if (productType === 'book') {
          await sendConfirmationEmail({
            email: session.customer_email,
            name: session.metadata.name,
            orderRef: session.metadata.orderRef,
            address: session.metadata.address,
            city: session.metadata.city,
            postcode: session.metadata.postcode,
            quantity: parseInt(session.metadata.quantity),
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
  res.json({ 
    status: 'OK',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

/**
 * Debug: Check Environment Variables (Development Only)
 */
app.get('/api/debug/env', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }
  
  res.json({
    stripePresentence: !!process.env.STRIPE_SECRET_KEY,
    googleSheetsPresentence: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    googleSheetsId: process.env.GOOGLE_SHEETS_ID ? 'Set' : 'Missing',
    googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'Set' : 'Missing',
    emailUserPresence: !!process.env.EMAIL_USER,
    emailPasswordPresence: !!process.env.EMAIL_PASSWORD,
    frontendUrl: process.env.FRONTEND_URL,
    nodeEnv: process.env.NODE_ENV
  });
});

/**
 * Test Google Sheets Connection
 */
app.get('/api/debug/test-sheets', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }
  
  try {
    console.log('Testing Google Sheets connection...');
    await initializeGoogleSheets();
    
    await doc.loadInfo();
    
    res.json({
      success: true,
      spreadsheetTitle: doc.title,
      sheetCount: doc.sheetCount,
      sheets: doc.sheetsByIndex.map(s => ({ title: s.title, rowCount: s.rowCount }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

/**
 * Production-Safe Sheets Health Check
 */
app.get('/api/sheets-health', async (req, res) => {
  try {
    console.log('📊 Testing Google Sheets connection...');
    
    const checks = {
      hasServiceAccountEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      hasServiceAccountKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      hasSheetsId: !!process.env.GOOGLE_SHEETS_ID,
    };
    
    await initializeGoogleSheets();
    await doc.loadInfo();
    
    res.json({
      success: true,
      message: 'Google Sheets connection successful',
      spreadsheetTitle: doc.title,
      sheetCount: doc.sheetCount,
      environmentChecks: checks,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Sheets health check failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      environmentChecks: {
        hasServiceAccountEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        hasServiceAccountKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        hasSheetsId: !!process.env.GOOGLE_SHEETS_ID,
      },
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================
// Start Server (Local Development Only)
// ============================================

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

module.exports = app;