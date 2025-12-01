/**
 * Supabase Edge Function for SMS Authentication using Authentica.sa
 * 
 * This function serves as a webhook handler for Supabase Auth's Send SMS Hook,
 * replacing the default Twilio integration with Authentica.sa's SMS service.
 * 
 * Flow: User Sign-in → Supabase Auth → Send SMS Hook → This Function → Authentica.sa API → SMS Sent
 * 
 * @author [Abdullah Alhaider](https://github.com/cs4alhaider)
 * @version 1.0.0
 */

// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

// Import for webhook verification (optional but recommended for security)
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

// Mark: Environment variables configuration
// ------------------------------------------------------------------------------------------------
// Authentica.sa API key for authentication (required)
const AUTHENTICA_API_KEY = Deno.env.get("AUTHENTICA_API_KEY");
// Authentica.sa template ID for SMS delivery (required)
const AUTHENTICA_SMS_TEMPLATE_ID = Deno.env.get("AUTHENTICA_SMS_TEMPLATE_ID") || Deno.env.get("AUTHENTICA_TEMPLATE_ID") || "31";
// Authentica.sa template ID for WhatsApp delivery (required if using WhatsApp)
const AUTHENTICA_WHATSAPP_TEMPLATE_ID = Deno.env.get("AUTHENTICA_WHATSAPP_TEMPLATE_ID") || "";
// Fallback email for SMS delivery failures (optional, default: noreply@yourdomain.com)
const FALLBACK_EMAIL = Deno.env.get("FALLBACK_EMAIL") || "noreply@yourdomain.com";
// Webhook secret for payload verification (required, generated in Supabase Dashboard)
const HOOK_SECRET = Deno.env.get("SEND_SMS_HOOK_SECRET");
// Comma-separated list of country codes that should use SMS (e.g., "+966,+971,+973")
// Numbers with these country codes will use SMS, all others will use WhatsApp (which is ~20x cheaper for international numbers)
// If empty or not set, ALL numbers will use SMS (default behavior)
const SMS_COUNTRY_CODES = Deno.env.get("SMS_COUNTRY_CODES") || "";
// ------------------------------------------------------------------------------------------------

/**
 * Parses the SMS_COUNTRY_CODES environment variable into a normalized array
 *
 * @returns {string[]} Array of country codes (normalized with + prefix)
 */
function getSmsCountryCodes(): string[] {
  return SMS_COUNTRY_CODES
    .split(",")
    .map(code => code.trim())
    .map(code => code.startsWith("+") ? code : `+${code}`)
    .filter(code => code.length > 1);
}

/**
 * Checks if a phone number should use SMS based on configured country codes
 * - If SMS_COUNTRY_CODES is empty/not set: ALL numbers use SMS (default)
 * - If SMS_COUNTRY_CODES is set: Only matching country codes use SMS, others use WhatsApp
 * - If AUTHENTICA_WHATSAPP_TEMPLATE_ID is not set: ALL numbers use SMS (WhatsApp not configured)
 *
 * @param {string} phone - The phone number to check (should include country code)
 * @returns {boolean} True if the number should use SMS
 */
function shouldUseSMS(phone: string): boolean {
  // If WhatsApp template is not configured, always use SMS
  if (!AUTHENTICA_WHATSAPP_TEMPLATE_ID) {
    return true;
  }

  const smsCountryCodes = getSmsCountryCodes();

  // If no country codes configured, use SMS for all numbers (default behavior)
  if (smsCountryCodes.length === 0) {
    return true;
  }

  // Normalize the phone number by removing spaces and dashes, ensure + prefix
  let normalized = phone.replace(/[\s-]/g, "");
  if (!normalized.startsWith("+")) {
    normalized = `+${normalized}`;
  }

  // Check if the phone number starts with any of the configured SMS country codes
  return smsCountryCodes.some(code => normalized.startsWith(code));
}

/**
 * Sends SMS via Authentica.sa API
 *
 * @param {string} phone - The recipient's phone number (should include country code)
 * @param {string} otp - The one-time password to send
 * @returns {Promise<{success: boolean, error?: string, data?: any}>} Result object indicating success/failure
 */
async function sendSMS(phone, otp) {
  // Validate that the API key is configured before attempting to send SMS
  if (!AUTHENTICA_API_KEY) {
    console.error("AUTHENTICA_API_KEY is not configured");
    return {
      success: false,
      error: "SMS service not configured"
    };
  }

  // Attempt to send SMS via Authentica.sa API
  try {
    // Determine delivery method based on phone number country code
    // Numbers matching SMS_COUNTRY_CODES use SMS, all others use WhatsApp (which is ~20x cheaper for international)
    const useSMS = shouldUseSMS(phone);
    const deliveryMethod = useSMS ? "sms" : "whatsapp";
    const templateId = useSMS ? AUTHENTICA_SMS_TEMPLATE_ID : AUTHENTICA_WHATSAPP_TEMPLATE_ID;

    console.log(`Sending OTP to ${phone} using template ${templateId} via ${deliveryMethod} (SMS country: ${useSMS})`);

    // Make API request to Authentica.sa send-otp endpoint
    const response = await fetch("https://api.authentica.sa/api/v2/send-otp", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "X-Authorization": AUTHENTICA_API_KEY, // Authentica.sa uses X-Authorization header
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        method: deliveryMethod, // SMS for configured country codes, WhatsApp for others (cheaper)
        phone: phone, // Recipient phone number
        template_id: parseInt(templateId), // Template based on delivery method (SMS or WhatsApp)
        fallback_email: FALLBACK_EMAIL, // Email fallback if SMS fails
        otp: otp // The OTP code to send
      })
    });

    // Get response text for logging and parsing
    const responseText = await response.text();
    console.log(`Authentica API Response Status: ${response.status}`);
    console.log(`Authentica API Response: ${responseText}`);

    // Parse JSON response, fallback to raw text if parsing fails
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText; // Keep raw response if JSON parsing fails
    }

    // Check if the HTTP response indicates an error
    if (!response.ok) {
      console.error("Authentica API error:", response.status, data);
      return {
        success: false,
        error: `Authentica API error: ${response.status}`,
        data
      };
    }

    // Return success with API response data
    return {
      success: true,
      data
    };
  } catch (error) {
    // Handle network errors, timeouts, and other exceptions
    console.error("Error sending SMS:", error);
    return {
      success: false,
      error: `Failed to send SMS` // it is recommended to not return the error message to the user for security reasons
      // but you can return the error message for debugging purposes
      // error: error.message || "Failed to send SMS"
    };
  }
}

/**
 * Main handler for the Supabase Edge Function
 * 
 * This function processes incoming webhook requests from Supabase Auth
 * when users attempt to sign in or verify their phone numbers.
 * 
 * IMPORTANT: This function must return a valid JSON response for Supabase to process correctly
 * 
 * @param {Request} req - The incoming HTTP request from Supabase Auth
 * @returns {Promise<Response>} HTTP response with JSON body
 */ 
Deno.serve(async (req) => {
  // Log the incoming request method for debugging
  console.log("Webhook received:", req.method);

  // Only accept POST requests as per Supabase webhook specification
  if (req.method !== "POST") {
    console.error("Invalid method:", req.method);
    return new Response(JSON.stringify({
      code: "method_not_allowed",
      message: "Only POST method is allowed"
    }), {
      status: 405,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }

  // Process the webhook request with comprehensive error handling
  try {
    // Extract the raw payload from the request
    const payload = await req.text();
    console.log("Raw payload received:", payload);

    // Initialize the event variable to store parsed webhook data
    let event;

    // Verify webhook signature if secret is configured (recommended for security)
    if (HOOK_SECRET) {
      try {
        // Extract all headers for signature verification
        const headers = Object.fromEntries(req.headers);
        console.log("Headers:", headers);
        
        // Remove the Supabase-specific prefix from the webhook secret
        const secret = HOOK_SECRET.replace("v1,whsec_", "");
        
        // Create webhook verifier instance and verify the payload
        const wh = new Webhook(secret);
        event = wh.verify(payload, headers);
        console.log("Webhook verified successfully");
      } catch (verifyError) {
        // Log verification failure but continue processing for debugging
        console.error("Webhook verification failed:", verifyError);
        // Parse payload anyway to allow debugging in development
        event = JSON.parse(payload);
        console.log("Parsed event despite verification failure:", event);
      }
    } else {
      // No webhook secret configured, parse payload directly (not recommended for production)
      event = JSON.parse(payload);
      console.log("Parsed event without verification:", event);
    }

    // Extract phone number and OTP from the webhook payload
    // Handle both 'phone' and 'new_phone' fields:
    // - 'phone' is used for existing users
    // - 'new_phone' is used for phone number changes and anonymous user upgrades
    const phone = event?.user?.phone || event?.user?.new_phone;
    const otp = event?.sms?.otp;

    // Log extracted values for debugging
    console.log("User phone:", event?.user?.phone);
    console.log("User new_phone:", event?.user?.new_phone);
    console.log("Selected phone:", phone);
    console.log("Extracted OTP:", otp);

    // Validate that phone number is present in the payload
    if (!phone) {
      console.error("Missing phone number in webhook payload (checked both phone and new_phone)");
      return new Response(JSON.stringify({
        code: "invalid_payload",
        message: "Missing phone number"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    // Validate that OTP is present in the payload
    if (!otp) {
      console.error("Missing OTP in webhook payload");
      return new Response(JSON.stringify({
        code: "invalid_payload",
        message: "Missing OTP"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    // Format phone number to ensure it includes country code prefix
    let formattedPhone = phone;
    if (!formattedPhone.startsWith("+")) {
      formattedPhone = "+" + formattedPhone;
    }
    console.log("Formatted phone:", formattedPhone);

    // Send SMS via Authentica.sa API
    const result = await sendSMS(formattedPhone, otp);

    // Handle SMS sending failure
    if (!result.success) {
      console.error("Failed to send SMS:", result.error);
      // Return 500 error to indicate SMS delivery failure to Supabase
      return new Response(JSON.stringify({
        code: "sms_send_failure",
        message: result.error || "Failed to send SMS"
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    console.log("SMS sent successfully");

    // IMPORTANT: Return valid JSON response for success
    // Supabase Auth expects a valid JSON response, not null or empty body
    return new Response(JSON.stringify({
      success: true
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });

  } catch (error) {
    // Handle any unexpected errors during request processing
    console.error("Unhandled error in webhook handler:", error);
    console.error("Error stack:", error.stack);
    
    // Return 500 error with error details
    return new Response(JSON.stringify({
      code: "unexpected_failure",
      message: error.message || "Internal server error"
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
