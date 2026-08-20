const mongoose = require("mongoose");

const LoanRepaymentSchema = new mongoose.Schema(
{
    loanId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Loans",
        required:true
    },

    userId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Users",
        required:true
    },

    amount:{
        type:Number,
        required:true
    },

    tx_ref:{
        type:String,
        required:true,
        unique:true
    },

    transactionId:{
        type:String,
        default:null
    },

    currency:{
        type:String,
        default:"NGN"
    },

    paymentMethod:{
        type:String,
        default:"flutterwave"
    },

    status:{
        type:String,
        enum:[
            "pending",
            "successful",
            "failed"
        ],
        default:"pending"
    },

    flutterwaveResponse:{
        type:Object,
        default:null
    },

    paidAt:{
        type:Date,
        default:null
    }

},
{
    timestamps:true
});

module.exports = mongoose.model(
    "LoanRepayments",
    LoanRepaymentSchema
);