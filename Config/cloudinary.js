const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

const dotenv = require("dotenv")

dotenv.config({path:require("path").join(__dirname, "../.env")})

// Configure Cloudinary with environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Setup Cloudinary Storage engine
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'socket_moni_kyc', // Cloudinary folder name
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
    resource_type: 'auto', // Allows automatic detection for images/documents
  },
});

// Dedicated selfie/profile-picture storage — same engine, separate folder
// and image-only validation so avatars never mix with KYC documents.
const avatarStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'socket_moni_selfie',
    allowed_formats: ['jpg', 'jpeg', 'png'],
    resource_type: 'image',
  },
});

// Defense-in-depth: restrict by MIME type as well as extension (Cloudinary's
// allowed_formats enforces extensions; this rejects clearly-invalid payloads).
const allowedMimeTypes = ["image/jpeg", "image/jpg", "image/png", "application/pdf"];
const kycFileFilter = (req, file, cb) => {
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error("Unsupported file type. Allowed formats: JPEG, PNG, PDF."));
  }
  cb(null, true);
};

// Multer upload middleware
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: kycFileFilter,
});

// Image-only MIME filter for profile pictures (reject PDFs).
const avatarFileFilter = (req, file, cb) => {
  const allowed = ["image/jpeg", "image/jpg", "image/png"];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error("Profile picture must be a JPEG, JPG, or PNG image."));
  }
  cb(null, true);
};

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: avatarFileFilter,
});

module.exports = { cloudinary, upload, kycFileFilter, avatarUpload, avatarFileFilter };