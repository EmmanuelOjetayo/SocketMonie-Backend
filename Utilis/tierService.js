const TIER_CONFIG = {
    bronze: {
        min: 5000,
        max: 20000,
        interestRate: 10,
        requiredKYC: ['passport', 'nin'],
        label: 'Bronze',
        benefits: ['Basic savings', '10% loan interest', 'Up to 70% borrowing limit'],
    },
    silver: {
        min: 21000,
        max: 50000,
        interestRate: 8,
        requiredKYC: ['passport', 'nin'],
        label: 'Silver',
        benefits: ['Priority savings', '8% loan interest', 'Up to 100% borrowing limit'],
    },
    gold: {
        min: 51000,
        max: 100000,
        interestRate: 6,
        requiredKYC: ['passport', 'nin', 'bvn'],
        label: 'Gold',
        benefits: ['Premium savings', '6% loan interest', 'Up to 150% borrowing limit', 'Priority support'],
    },
    platinum: {
        min: 100000,
        max: Infinity,
        interestRate: 5,
        requiredKYC: ['passport', 'nin', 'bvn', 'drivers_license_or_voters_card'],
        label: 'Platinum',
        benefits: ['Elite savings', '5% loan interest', 'Up to 200% borrowing limit', 'VIP support', 'Financial advisory'],
    },
};

function getTierBySavings(averageMonthlySavings) {
    if (averageMonthlySavings >= TIER_CONFIG.platinum.min) return 'platinum';
    if (averageMonthlySavings >= TIER_CONFIG.gold.min) return 'gold';
    if (averageMonthlySavings >= TIER_CONFIG.silver.min) return 'silver';
    return 'bronze';
}

function meetsKYCForTier(user, tier) {
    const required = TIER_CONFIG[tier].requiredKYC;
    const missing = [];
    const hasPassport = !!user.selfieUrl;
    const hasNIN = !!user.nin;
    const hasBVN = !!user.bvn;
    const hasDriversLicenseOrVoter = (user.documentType === 'drivers_license' || user.documentType === 'voters_card') && !!user.documentUrl;
    const checks = {
        passport: hasPassport,
        nin: hasNIN,
        bvn: hasBVN,
        'drivers_license_or_voters_card': hasDriversLicenseOrVoter,
    };
    required.forEach(req => { if (!checks[req]) missing.push(req); });
    return { meets: missing.length === 0, missing };
}

function getTierDetails(tier) { return TIER_CONFIG[tier] || null; }
function getAllTiers() { return TIER_CONFIG; }
function getInterestRate(tier) { return TIER_CONFIG[tier]?.interestRate || 10; }

// AFTER
function canUpgradeToTier(user, targetTier) {
    const reasons = [];
    const currentTier = (user.tier || 'Bronze').toLowerCase();
    const tierOrder = ['bronze', 'silver', 'gold', 'platinum'];
    const currentIndex = tierOrder.indexOf(currentTier);
    const targetIndex = tierOrder.indexOf(targetTier);
    if (targetIndex <= currentIndex) {
        reasons.push('Target tier must be higher than current tier.');
        return { canUpgrade: false, reasons };
    }
    const kycCheck = meetsKYCForTier(user, targetTier);
    if (!kycCheck.meets) {
        reasons.push(`Missing KYC requirements: ${kycCheck.missing.join(', ')}`);
    }
    return { canUpgrade: reasons.length === 0, reasons };
}


// ADD THIS HELPER TO YOUR EXISTING tierService.js FILE
function getMinCommitmentForTier(tier) {
  const normalizedKey = (tier || "bronze").toLowerCase();
  return TIER_CONFIG[normalizedKey]?.min || 5000;
}

// UPDATE YOUR module.exports AT THE BOTTOM TO INCLUDE IT:
module.exports = {
  TIER_CONFIG,
  getTierBySavings,
  meetsKYCForTier,
  getTierDetails,
  getAllTiers,
  getInterestRate,
  canUpgradeToTier,
  getMinCommitmentForTier, // <-- ADDED HERE
};
