const { CourierClient } = require("@trycourier/courier");

const courier = new CourierClient({ authorizationToken: process.env.COURIER_API_KEY });

async function sendEmail({ to, subject, content }) {
  try {
    const { requestId } = await courier.send({
      message: {
        to: {
          email: to,
        },
        template: "VVSWWV1GSE4WZ9P3FBB97Y1PG01R", // Create a template in Courier dashboard
        data: {
          recipientName: subject,
          contenu: content,
        },
      },
    });
    return { success: true, requestId };
  } catch (error) {
    console.error("Error sending email:", error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

module.exports = { sendEmail };
