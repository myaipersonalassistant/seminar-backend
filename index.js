const express = require('express');
require('dotenv').config();

const nodemailer = require('nodemailer');
const cors = require('cors');
const crypto = require('crypto');

// Verify critical environment variables are loaded
// Optional: ADMIN_SECRET for admin token signing (defaults to STRIPE_SECRET_KEY in dev)
const requiredEnvVars = ['STRIPE_SECRET_KEY', 'FIREBASE_PROJECT_ID', 'EMAIL_USER', 'EMAIL_PASSWORD'];
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

// Middleware - CORS with Authorization header for admin API
app.use(cors({
  origin: process.env.FRONTEND_URL || true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Raw body for webhook signature verification MUST be registered before express.json()
// so Stripe's signature verification receives the raw payload unchanged.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(express.json());

// ============================================
// Firestore Setup (Lazy Initialization)
// ============================================

let firestoreInitialized = false;
let db;

async function initializeFirestore() {
  if (firestoreInitialized) {
    return;
  }
  
  try {
    // Check required environment variables
    if (!process.env.FIREBASE_PROJECT_ID) {
      throw new Error('FIREBASE_PROJECT_ID is not set');
    }
    
    // Lazy load firebase-admin
    const admin = require('firebase-admin');
    
    // Initialize Firebase Admin if not already initialized
    if (admin.apps.length === 0) {
      // Check if we have service account credentials
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Parse service account from environment variable (JSON string)
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: process.env.FIREBASE_PROJECT_ID,
        });
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        // Use service account file path
        const serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: process.env.FIREBASE_PROJECT_ID,
        });
      } else {
        // Try to initialize with project ID only (for App Engine, Cloud Functions, etc.)
        admin.initializeApp({
          projectId: process.env.FIREBASE_PROJECT_ID,
        });
      }
    }
    
    db = admin.firestore();
    firestoreInitialized = true;
  } catch (error) {
    console.error('❌ Error initializing Firestore:', error.message);
    console.error('Full error:', error);
    firestoreInitialized = false;
    throw error;
  }
}

async function addToFirestore(data) {
  try {
    await initializeFirestore();
    
    const admin = require('firebase-admin');
    const COLLECTION_NAME = 'ticket_purchases';
    const orderRef = db.collection(COLLECTION_NAME).doc(data.order_reference);
    
    const orderData = {
      order_reference: data.order_reference,
      customer_name: data.customer_name,
      customer_email: data.customer_email,
      customer_phone: data.customer_phone || '',
      quantity: data.quantity || 1,
      amount_total: data.amount_total,
      stripe_session_id: data.stripe_session_id || '',
      stripe_payment_intent_id: data.stripe_payment_intent_id || '',
      status: data.status,
      product_type: data.product_type || 'ticket',
      shipping_address: data.shipping_address || '',
      shipping_city: data.shipping_city || '',
      shipping_postcode: data.shipping_postcode || '',
      created_at: admin.firestore.Timestamp.fromDate(new Date(data.created_at)),
      updated_at: admin.firestore.Timestamp.fromDate(new Date(data.updated_at)),
    };
    
    await orderRef.set(orderData);
    
    return orderData;
  } catch (error) {
    console.error('Error adding to Firestore:', error.message);
    throw error;
  }
}

async function updateFirestore(orderRef, updates) {
  try {
    await initializeFirestore();
    
    const admin = require('firebase-admin');
    const COLLECTION_NAME = 'ticket_purchases';
    const orderDoc = db.collection(COLLECTION_NAME).doc(orderRef);
    
    // Check if document exists
    const docSnapshot = await orderDoc.get();
    
    if (!docSnapshot.exists) {
      // Try to find by order_reference field
      const querySnapshot = await db.collection(COLLECTION_NAME)
        .where('order_reference', '==', orderRef)
        .limit(1)
        .get();
      
      if (querySnapshot.empty) {
        return null;
      }
      
      // Update the found document
      const foundDoc = querySnapshot.docs[0];
      const updateData = {
        ...updates,
        updated_at: admin.firestore.Timestamp.now(),
      };
      
      // Convert string dates to Timestamps if needed
      if (updateData.created_at && typeof updateData.created_at === 'string') {
        updateData.created_at = admin.firestore.Timestamp.fromDate(new Date(updateData.created_at));
      }
      if (updateData.updated_at && typeof updateData.updated_at === 'string') {
        updateData.updated_at = admin.firestore.Timestamp.fromDate(new Date(updateData.updated_at));
      }
      if (updateData.email_sent_at && typeof updateData.email_sent_at === 'string') {
        updateData.email_sent_at = admin.firestore.Timestamp.fromDate(new Date(updateData.email_sent_at));
      }
      if (updateData.email_last_attempt && typeof updateData.email_last_attempt === 'string') {
        updateData.email_last_attempt = admin.firestore.Timestamp.fromDate(new Date(updateData.email_last_attempt));
      }
      
      await foundDoc.ref.update(updateData);
      
      const updatedDoc = await foundDoc.ref.get();
      return convertFirestoreData(updatedDoc.data());
    } else {
      const updateData = {
        ...updates,
        updated_at: admin.firestore.Timestamp.now(),
      };
      
      // Convert string dates to Timestamps if needed
      if (updateData.created_at && typeof updateData.created_at === 'string') {
        updateData.created_at = admin.firestore.Timestamp.fromDate(new Date(updateData.created_at));
      }
      if (updateData.updated_at && typeof updateData.updated_at === 'string') {
        updateData.updated_at = admin.firestore.Timestamp.fromDate(new Date(updateData.updated_at));
      }
      if (updateData.email_sent_at && typeof updateData.email_sent_at === 'string') {
        updateData.email_sent_at = admin.firestore.Timestamp.fromDate(new Date(updateData.email_sent_at));
      }
      if (updateData.email_last_attempt && typeof updateData.email_last_attempt === 'string') {
        updateData.email_last_attempt = admin.firestore.Timestamp.fromDate(new Date(updateData.email_last_attempt));
      }
      
      await orderDoc.update(updateData);
      
      const updatedDoc = await orderDoc.get();
      return convertFirestoreData(updatedDoc.data());
    }
  } catch (error) {
    console.error('Error updating Firestore:', error.message);
    throw error;
  }
}

// Helper function to convert Firestore timestamps to ISO strings
function convertFirestoreData(data) {
  if (!data) return null;
  
  const converted = { ...data };
  
  // Convert Firestore Timestamps to ISO strings
  if (converted.created_at && converted.created_at.toDate) {
    converted.created_at = converted.created_at.toDate().toISOString();
  }
  if (converted.updated_at && converted.updated_at.toDate) {
    converted.updated_at = converted.updated_at.toDate().toISOString();
  }
  if (converted.email_sent_at && converted.email_sent_at.toDate) {
    converted.email_sent_at = converted.email_sent_at.toDate().toISOString();
  }
  if (converted.email_last_attempt && converted.email_last_attempt.toDate) {
    converted.email_last_attempt = converted.email_last_attempt.toDate().toISOString();
  }
  
  return converted;
}

// ============================================
// Admin Auth (Option B - server-side)
// ============================================

const ADMIN_COLLECTION = 'admin';
const TOKEN_EXPIRY_HOURS = 24;

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex').toLowerCase();
}

function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  return Buffer.from(b64, 'base64');
}

function createAdminToken(admin) {
  const secret = process.env.ADMIN_SECRET || process.env.STRIPE_SECRET_KEY || 'dev-secret-change-in-production';
  const payload = {
    adminId: admin.id,
    username: admin.username,
    exp: Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000,
  };
  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = toBase64Url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return null;
  const secret = process.env.ADMIN_SECRET || process.env.STRIPE_SECRET_KEY || 'dev-secret-change-in-production';
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  try {
    const [payloadB64, sig] = parts;
    const expectedSig = toBase64Url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function loginAdmin(username, password) {
  await initializeFirestore();
  const snapshot = await db.collection(ADMIN_COLLECTION).where('username', '==', username).limit(1).get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  const data = doc.data();
  const storedHash = (data.password_hash || '').trim();
  const passwordHash = hashPassword(password);
  const isStoredHash = storedHash.length === 64 && /^[a-f0-9]{64}$/i.test(storedHash);
  let valid = false;
  if (isStoredHash) {
    valid = storedHash.toLowerCase() === passwordHash;
  } else {
    valid = storedHash === password;
  }
  if (!valid) return null;
  await doc.ref.update({ last_login: require('firebase-admin').firestore.Timestamp.now() });
  return { id: doc.id, username: data.username, email: data.email || '', role: data.role || 'admin' };
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = verifyAdminToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized. Valid admin token required.' });
  }
  req.admin = payload;
  next();
}

async function getFromFirestore(orderRef) {
  try {
    await initializeFirestore();
    
    const COLLECTION_NAME = 'ticket_purchases';
    const orderDoc = db.collection(COLLECTION_NAME).doc(orderRef);
    
    // Try to get by document ID first
    const docSnapshot = await orderDoc.get();
    
    if (docSnapshot.exists) {
      return convertFirestoreData(docSnapshot.data());
    }
    
    // If not found, try querying by order_reference field
    const querySnapshot = await db.collection(COLLECTION_NAME)
      .where('order_reference', '==', orderRef)
      .limit(1)
      .get();
    
    if (querySnapshot.empty) {
      return null;
    }
    
    return convertFirestoreData(querySnapshot.docs[0].data());
  } catch (error) {
    console.error('Error reading from Firestore:', error.message);
    throw error;
  }
}

// ============================================
// Email Setup
// ============================================

// Email transporter configuration
// Supports multiple email providers: Gmail, Outlook, custom SMTP
// For Gmail: Use App Password (enable 2-Step Verification first)
// For Outlook: Use App Password or OAuth2
// For custom SMTP: Set EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE
let transporter;

try {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.warn('⚠️ Email credentials not configured. Email functionality will be disabled.');
    transporter = null;
  } else {
    // Determine email service configuration
    const emailUser = process.env.EMAIL_USER.toLowerCase();
    let emailConfig;
    
    // Check for custom SMTP settings first (highest priority)
    if (process.env.EMAIL_HOST && process.env.EMAIL_PORT) {
      // Custom SMTP configuration
      emailConfig = {
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: process.env.EMAIL_SECURE === 'true' || process.env.EMAIL_PORT === '465', // true for 465, false for other ports
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD,
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
      };
    } else if (emailUser.includes('@gmail.com') || emailUser.includes('@googlemail.com')) {
      // Gmail configuration
      emailConfig = {
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD, // MUST be an App Password
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
      };
    } else if (emailUser.includes('@outlook.com') || emailUser.includes('@hotmail.com') || emailUser.includes('@live.com')) {
      // Outlook/Hotmail configuration
      emailConfig = {
        service: 'hotmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD, // App Password recommended
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
      };
    } else if (process.env.EMAIL_HOST === 'mail.privateemail.com' || process.env.EMAIL_HOST === 'smtp.privateemail.com') {
      // PrivateEmail (Namecheap) - use provided SMTP settings
      emailConfig = {
        host: process.env.EMAIL_HOST || 'mail.privateemail.com',
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: process.env.EMAIL_SECURE === 'true' || process.env.EMAIL_PORT === '465',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD,
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
      };
    } else {
      // Custom domain email - requires SMTP settings
      console.error('❌ Custom domain email detected but SMTP settings not provided!');
      console.error(`   Email: ${process.env.EMAIL_USER}`);
      console.error('   You must provide EMAIL_HOST and EMAIL_PORT environment variables');
      console.error('   Example:');
      console.error('     EMAIL_HOST=smtp.example.com');
      console.error('     EMAIL_PORT=587');
      console.error('     EMAIL_SECURE=false');
      throw new Error('Custom domain email requires EMAIL_HOST and EMAIL_PORT. Please configure SMTP settings.');
    }
    
    transporter = nodemailer.createTransport(emailConfig);
    
    // Verify connection on startup (async, don't block)
    transporter.verify(function (error, success) {
      if (error) {
        console.error('Email transporter verification failed:', error.message);
      }
    });
  }
} catch (error) {
  console.error('❌ Error setting up email transporter:', error.message);
  transporter = null;
}

async function sendConfirmationEmail(data, type = 'ticket', orderRef = null) {
  try {
    // Check if email transporter is configured
    if (!transporter) {
      throw new Error('Email transporter is not configured. Please set EMAIL_USER and EMAIL_PASSWORD environment variables.');
    }
    
    // Get sender name from environment or use default
    const senderName = process.env.EMAIL_SENDER_NAME || 'Build Wealth Through Property';
    const senderEmail = process.env.EMAIL_USER;
    const replyTo = process.env.EMAIL_REPLY_TO || senderEmail;
    
    let subject, html, text;
    
    if (type === 'book') {
      subject = `Order Confirmed - Your Book Purchase (${data.orderRef})`;
      
      // Plain text version for better deliverability
      text = `Order Confirmed - Your Book Purchase

Hi ${data.name},

Thank you for purchasing "Build Wealth Through Property — 7 Reasons Why". Your order has been confirmed!

Your Order Details:
- Order Reference: ${data.orderRef}
- Product: Build Wealth Through Property — 7 Reasons Why
- Quantity: ${data.quantity || 1} ${(data.quantity || 1) > 1 ? 'books' : 'book'}
- Shipping Address: ${data.address}
- City: ${data.city}
- Postcode: ${data.postcode}
- Total Amount: £${(data.amountTotal / 100).toFixed(2)}

100% of proceeds go to Place of Victory Charity
Thank you for supporting our charity mission!

What Happens Next?
- Your book${(data.quantity || 1) > 1 ? 's' : ''} will be shipped to the address provided
- You will receive a shipping confirmation email once your order is dispatched
- Expected delivery: 5-7 business days

If you have any questions, please reply to this email or visit our website.

Best regards,
The Team`;
      
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
      
      // Plain text version
      text = `Booking Confirmed - Your Seminar Tickets

Hi ${data.name},

Thank you for booking your tickets to our seminar. Your booking has been confirmed!

Your Booking Details:
- Order Reference: ${data.orderRef}
- Number of Tickets: ${data.quantity}
- Event Date: Saturday, 14 March 2026
- Event Time: 2:00 PM – 5:00 PM (Doors open 1:15 PM)
- Venue: Europa Hotel, Great Victoria Street, Belfast BT2 7AP

What to Bring:
- This confirmation email (digital or printed)
- A valid ID
- Your order reference: ${data.orderRef}

We look forward to seeing you at the seminar!

Best regards,
The Team`;
      
      html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #2d3748; margin-bottom: 20px;">Booking Confirmed! 🎉</h1>
          
          <p>Hi ${data.name},</p>
          
          <p>Thank you for booking your tickets to our seminar. Your booking has been confirmed!</p>
          
          <div style="background-color: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Your Booking Details</h3>
            <p><strong>Order Reference:</strong> ${data.orderRef}</p>
            <p><strong>Number of Tickets:</strong> ${data.quantity}</p>
            <p><strong>Event Date:</strong> Saturday, 14 March 2026</p>
            <p><strong>Event Time:</strong> 2:00 PM – 5:00 PM (Doors open 1:15 PM)</p>
            <p><strong>Venue:</strong> Europa Hotel, Great Victoria Street, Belfast BT2 7AP</p>
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

    // Generate unique Message-ID for better deliverability
    const domain = senderEmail.split('@')[1];
    const messageId = `<${orderRef || Date.now()}-${Math.random().toString(36).substr(2, 9)}@${domain}>`;
    
    // Get website URL for unsubscribe link
    const websiteUrl = process.env.FRONTEND_URL || 'https://www.wealthforall.com';
    
    await transporter.sendMail({
      from: `"${senderName}" <${senderEmail}>`,
      to: data.email,
      replyTo: replyTo,
      subject: subject,
      text: text, // Plain text version improves deliverability
      html: html,
      headers: {
        'Message-ID': messageId,
        'X-Mailer': 'Build Wealth Through Property Booking System',
        'X-Priority': '1',
        'Importance': 'high',
        'List-Unsubscribe': `<${websiteUrl}>, <mailto:${replyTo}?subject=Unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'MIME-Version': '1.0',
        'Content-Type': 'text/html; charset=UTF-8',
      },
      priority: 'high',
      date: new Date(),
    });
    
    // Update email tracking in Firestore if orderRef is provided
    if (orderRef) {
      try {
        const currentOrder = await getFromFirestore(orderRef);
        const emailSentCount = (currentOrder?.email_sent_count || 0) + 1;
        
        await updateFirestore(orderRef, {
          email_sent: true,
          email_sent_at: new Date().toISOString(),
          email_sent_count: emailSentCount,
          email_last_attempt: new Date().toISOString(),
          email_status: 'sent',
        });
      } catch (firestoreError) {
        console.error('Error updating email tracking in Firestore:', firestoreError);
        // Don't throw - email was sent successfully
      }
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error sending email:', error);
    
    // Update email tracking in Firestore if orderRef is provided
    if (orderRef) {
      try {
        const currentOrder = await getFromFirestore(orderRef);
        const emailSentCount = (currentOrder?.email_sent_count || 0) + 1;
        
        await updateFirestore(orderRef, {
          email_sent: false,
          email_last_attempt: new Date().toISOString(),
          email_sent_count: emailSentCount,
          email_status: 'failed',
        });
      } catch (firestoreError) {
        console.error('Error updating email failure tracking in Firestore:', firestoreError);
        // Don't throw - we're already handling the email error
      }
    }
    
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
          description: 'Saturday, 14 March 2026 at Ramada Encore Chatham',
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

    // Save to Firestore with pending status
    await addToFirestore({
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
              description: 'Saturday, 14 March 2026 at Ramada Encore Chatham',
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

    // Save to Firestore with pending status
    await addToFirestore({
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

    // Save to Firestore with pending status
    await addToFirestore({
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
 * Admin Login (Option B - replaces client Firestore access)
 */
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const admin = await loginAdmin(username, password);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = createAdminToken(admin);
    res.json({
      success: true,
      admin: { id: admin.id, username: admin.username, email: admin.email, role: admin.role },
      token,
      loginTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * List All Tickets (admin only)
 */
app.get('/api/tickets', requireAdmin, async (req, res) => {
  try {
    await initializeFirestore();
    const snapshot = await db.collection('ticket_purchases').get();
    const orders = snapshot.docs.map((d) => {
      const data = convertFirestoreData(d.data());
      return { ...data, order_reference: data.order_reference || d.id };
    });
    orders.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    res.json(orders);
  } catch (error) {
    console.error('Error listing tickets:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Ticket Purchase (public - for payment success page, order_ref is the secret)
 */
app.get('/api/tickets/:orderReference', async (req, res) => {
  try {
    const { orderReference } = req.params;

    const ticket = await getFromFirestore(orderReference);

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
 * Add Ticket Purchase (internal use by checkout flow)
 */
app.post('/api/tickets', async (req, res) => {
  try {
    const data = req.body;

    await addToFirestore(data);

    res.json({ success: true, order_reference: data.order_reference });
  } catch (error) {
    console.error('Error adding ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update Ticket Purchase (admin only)
 */
app.patch('/api/tickets/:orderReference', requireAdmin, async (req, res) => {
  try {
    const { orderReference } = req.params;
    const updates = req.body;

    await updateFirestore(orderReference, updates);

    const updated = await getFromFirestore(orderReference);

    res.json(updated);
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Admin Analytics - Page Views (admin only)
 */
app.get('/api/admin/analytics/page-views', requireAdmin, async (req, res) => {
  try {
    await initializeFirestore();
    const snapshot = await db.collection('page_views')
      .orderBy('timestamp', 'desc')
      .limit(10000)
      .get();
    const views = snapshot.docs.map((d) => {
      const data = d.data();
      return { id: d.id, ...data, timestamp: data.timestamp?.toDate?.()?.toISOString?.() || data.timestamp };
    });
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    let filtered = views;
    if (startDate || endDate) {
      filtered = views.filter((v) => {
        const d = v.timestamp ? new Date(v.timestamp) : null;
        if (!d) return true;
        if (startDate && d < startDate) return false;
        if (endDate && d > endDate) return false;
        return true;
      });
    }
    res.json(filtered);
  } catch (error) {
    console.error('Error fetching page views:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Admin Analytics - Visitors (admin only)
 */
app.get('/api/admin/analytics/visitors', requireAdmin, async (req, res) => {
  try {
    await initializeFirestore();
    const snapshot = await db.collection('visitors').get();
    const visitors = snapshot.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        first_seen: data.first_seen?.toDate?.()?.toISOString?.() || data.first_seen,
        last_visit: data.last_visit?.toDate?.()?.toISOString?.() || data.last_visit,
      };
    });
    res.json(visitors);
  } catch (error) {
    console.error('Error fetching visitors:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Admin - Merged Leads (admin only)
 * Combines leads from: reasons_unlock_leads + ticket_purchases (orders)
 * Dedupes by email (lowercase). Sources: reasons_unlock, order
 */
app.get('/api/admin/leads', requireAdmin, async (req, res) => {
  try {
    await initializeFirestore();
    const byEmail = new Map(); // email (lowercase) -> { id, name, email, sources, firstSeen, lastActivity }

    // 1. Reasons unlock leads
    const unlockSnap = await db.collection('reasons_unlock_leads').get();
    unlockSnap.docs.forEach((d) => {
      const data = d.data();
      const email = (data.email || '').trim().toLowerCase();
      if (!email) return;
      const created = data.created_at?.toDate?.()?.toISOString?.() || new Date().toISOString();
      const existing = byEmail.get(email);
      if (!existing) {
        byEmail.set(email, {
          id: `unlock-${d.id}`,
          name: (data.name || '').trim() || email,
          email: data.email?.trim() || email,
          sources: ['reasons_unlock'],
          firstSeen: created,
          lastActivity: created,
        });
      } else {
        existing.sources = [...new Set([...existing.sources, 'reasons_unlock'])];
        if (created < existing.firstSeen) existing.firstSeen = created;
        if (created > existing.lastActivity) existing.lastActivity = created;
      }
    });

    // 2. Ticket purchases (orders) - customer_name + customer_email
    const ordersSnap = await db.collection('ticket_purchases').get();
    ordersSnap.docs.forEach((d) => {
      const data = d.data();
      const email = (data.customer_email || '').trim().toLowerCase();
      if (!email) return;
      const created = data.created_at?.toDate?.()?.toISOString?.() || data.created_at || new Date().toISOString();
      const existing = byEmail.get(email);
      const name = (data.customer_name || '').trim() || email;
      if (!existing) {
        byEmail.set(email, {
          id: `order-${d.id}`,
          name,
          email: data.customer_email?.trim() || email,
          sources: ['order'],
          firstSeen: created,
          lastActivity: created,
        });
      } else {
        existing.sources = [...new Set([...existing.sources, 'order'])];
        if (name && name !== email) existing.name = name; // prefer order name (verified)
        if (created < existing.firstSeen) existing.firstSeen = created;
        if (created > existing.lastActivity) existing.lastActivity = created;
      }
    });

    const leads = Array.from(byEmail.values())
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
      .map((l, i) => ({ ...l, id: l.id || `lead-${i}` }));
    res.json(leads);
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Admin Analytics - Events (admin only)
 * Uses Firestore date range query when possible to reduce reads
 */
app.get('/api/admin/analytics/events', requireAdmin, async (req, res) => {
  try {
    await initializeFirestore();
    const admin = require('firebase-admin');
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    const maxLimit = 2000;

    let query = db.collection('analytics_events').orderBy('timestamp', 'desc');

    if (startDate || endDate) {
      if (startDate) {
        query = query.where('timestamp', '>=', admin.firestore.Timestamp.fromDate(startDate));
      }
      if (endDate) {
        query = query.where('timestamp', '<=', admin.firestore.Timestamp.fromDate(endDate));
      }
    }

    const snapshot = await query.limit(maxLimit).get();
    const events = snapshot.docs.map((d) => {
      const data = d.data();
      return { id: d.id, ...data, timestamp: data.timestamp?.toDate?.()?.toISOString?.() || data.timestamp };
    });
    res.json(events);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Stripe Webhook Handler
 */
app.post('/api/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, endpointSecret);
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
        
        // Retrieve the payment intent to get more details
        let paymentIntentId = session.payment_intent;
        try {
          const paymentIntent = await getStripe().paymentIntents.retrieve(session.payment_intent);
          paymentIntentId = paymentIntent.id;
        } catch (piErr) {
          // Payment intent retrieval failed, use session payment_intent
        }
        
        // Update Firestore with completed status
        await updateFirestore(session.metadata.orderRef, {
          status: 'completed',
          stripe_payment_intent_id: paymentIntentId || session.payment_intent || '',
          updated_at: new Date().toISOString(),
        });

        // Send confirmation email based on product type
        try {
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
            }, 'book', session.metadata.orderRef);
          } else {
            await sendConfirmationEmail({
              email: session.customer_email,
              name: session.metadata.name,
              orderRef: session.metadata.orderRef,
              quantity: session.metadata.quantity,
            }, 'ticket', session.metadata.orderRef);
          }
        } catch (emailError) {
          console.error(`Failed to send email to ${session.customer_email}:`, emailError.message);
          // Don't throw - we still want to mark payment as completed even if email fails
        }
        break;

      case 'checkout.session.expired':
        const expiredSession = event.data.object;
        
        // Update status to failed
        await updateFirestore(expiredSession.metadata.orderRef, {
          status: 'failed',
          updated_at: new Date().toISOString(),
        });

        break;

      default:
        // Unhandled event type
        break;
    }

    res.json({received: true});
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Manually Send Confirmation Email (admin only)
 * Admin endpoint to resend confirmation emails
 */
app.post('/api/send-email/:orderReference', requireAdmin, async (req, res) => {
  try {
    const { orderReference } = req.params;
    
    // Get order from Firestore
    const order = await getFromFirestore(orderReference);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    // Only send emails for completed orders
    if (order.status !== 'completed') {
      return res.status(400).json({ 
        error: `Cannot send email for order with status: ${order.status}. Order must be completed.` 
      });
    }
    
    const productType = order.product_type || 'ticket';
    
    // Prepare email data
    const emailData = {
      email: order.customer_email,
      name: order.customer_name,
      orderRef: order.order_reference,
      quantity: order.quantity,
    };
    
    if (productType === 'book') {
      emailData.address = order.shipping_address || '';
      emailData.city = order.shipping_city || '';
      emailData.postcode = order.shipping_postcode || '';
      emailData.amountTotal = order.amount_total;
    }
    
    // Send email
    await sendConfirmationEmail(emailData, productType, orderReference);
    
    res.json({
      success: true,
      message: `Confirmation email sent successfully to ${order.customer_email}`,
      orderReference: orderReference,
      emailSentAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error sending email manually:', error);
    
    // Provide helpful error messages
    let errorMessage = error.message || 'Failed to send email';
    let hint = '';
    
    if (error.code === 'EAUTH' || error.responseCode === 535) {
      errorMessage = 'Gmail authentication failed. Invalid credentials.';
      hint = 'Make sure you are using a Gmail App Password (not your regular password). Enable 2-Step Verification and generate an App Password at: https://myaccount.google.com/apppasswords';
    } else if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') {
      errorMessage = 'Failed to connect to email server.';
      hint = 'Check your internet connection and email server settings.';
    }
    
    res.status(500).json({
      error: errorMessage,
      hint: hint,
      success: false,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
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
    stripePresence: !!process.env.STRIPE_SECRET_KEY,
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ? 'Set' : 'Missing',
    firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT ? 'Set' : 'Missing',
    googleApplicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'Set' : 'Missing',
    emailUserPresence: !!process.env.EMAIL_USER,
    emailPasswordPresence: !!process.env.EMAIL_PASSWORD,
    frontendUrl: process.env.FRONTEND_URL,
    nodeEnv: process.env.NODE_ENV
  });
});

/**
 * Test Firestore Connection
 */
app.get('/api/debug/test-firestore', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }
  
  try {
    await initializeFirestore();
    
    // Try to read from the collection
    const testQuery = await db.collection('ticket_purchases').limit(1).get();
    
    res.json({
      success: true,
      message: 'Firestore connection successful',
      projectId: process.env.FIREBASE_PROJECT_ID,
      collectionAccessible: true,
      sampleCount: testQuery.size
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
 * Production-Safe Firestore Health Check
 */
app.get('/api/firestore-health', async (req, res) => {
  try {
    const checks = {
      hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
      hasServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      hasCredentialsFile: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
    };
    
    await initializeFirestore();
    
    // Try a simple read operation
    const testQuery = await db.collection('ticket_purchases').limit(1).get();
    
    res.json({
      success: true,
      message: 'Firestore connection successful',
      projectId: process.env.FIREBASE_PROJECT_ID,
      environmentChecks: checks,
      collectionAccessible: true,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Firestore health check failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      environmentChecks: {
        hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
        hasServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
        hasCredentialsFile: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
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
    // Server started
  });
}


module.exports = app;