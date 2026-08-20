const genOTP = () => {
  return Math.floor(Math.random() * 9000) + 1000;
};

module.exports = genOTP;