class AppError extends Error{
    constructor(message, statusCode){
        super(message);
        this.statusCode = statusCode;
        this.operational = true;
        Error.captureStackTrace(this, this.constructor)
    }
}

module.exports = AppError;