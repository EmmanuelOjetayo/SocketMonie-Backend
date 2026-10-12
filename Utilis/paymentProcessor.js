const { processLoanRepayment } = require("../Controllers/LoanController");

async function processPayment(payment) {

    const tx_ref = payment.tx_ref;

    if (tx_ref.startsWith("LRP_")) {
        return processLoanRepayment(payment);
    }

    throw new Error(`Unknown payment reference: ${tx_ref}`);
}

module.exports = {
    processPayment,
};