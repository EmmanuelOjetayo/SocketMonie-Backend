const Notification = require("../Models/NotificationModel");
const User = require("../Models/UserModel");

const createNotification = async ({ userId, type, title, message, data }) => {
  try {
    await Notification.create({
      userId,
      type,
      title,
      message,
      data: data || null,
    });
  } catch (err) {
    console.error("Failed to create notification:", err);
  }
};

const broadcastNotification = async ({ type, title, message, data, excludeUserIds = [] }) => {
  try {
    const users = await User.find({ 
      _id: { $nin: excludeUserIds },
      status: { $ne: 'suspended' }
    }).select('_id');
    const notifications = users.map(user => ({
      userId: user._id,
      type,
      title,
      message,
      data: data || null,
    }));
    if (notifications.length > 0) {
      await Notification.insertMany(notifications);
      console.log(`Broadcast notification sent to ${notifications.length} users`);
    }
  } catch (err) {
    console.error("Failed to broadcast notification:", err);
  }
};

module.exports = { createNotification, broadcastNotification };