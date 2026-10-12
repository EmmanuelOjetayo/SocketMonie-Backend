const { RecoveryService } = require("../Services/RecoveryService");

exports.list = async (req, res, next) => {
  try {
    const obligations = await RecoveryService.listForGuarantor(req.user._id);
    return res.status(200).json({ success: true, data: obligations });
  } catch (error) { next(error); }
};

exports.createPayment = async (req, res, next) => {
  try {
    const payment = await RecoveryService.createPaymentIntent({
      obligationId: req.params.obligationId,
      guarantorUserId: req.user._id,
      amount: req.body.amount,
    });
    return res.status(201).json({ success: true, data: payment });
  } catch (error) { next(error); }
};

exports.completePayment = async (req, res, next) => {
  try {
    const payment = await RecoveryService.completePayment({
      reference: req.body.reference,
      providerReference: req.body.providerReference,
      callerUserId: req.user._id,
    });
    return res.status(200).json({ success: true, data: payment });
  } catch (error) { next(error); }
};