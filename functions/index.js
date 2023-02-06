const functions = require("firebase-functions");

const admin = require("firebase-admin");
const functionsAdmin = require("firebase-admin/functions");

admin.initializeApp();

const AUTO_CANCEL_ORDER_MINS = 30;
const TIME_ZONE = "Asia/Singapore";

exports.scheduleCancelOrder = functions
    .firestore.document("/orders/{orderId}")
    .onCreate(async (snap, context) => {
      const orderId = context.params.orderId;
      const itemRef =
        admin.firestore().collection("items").doc(snap.data().itemId);
      functions.logger.log("Getting item for", snap.data().itemId);
      const item = (await itemRef.get()).data();
      const queue = functionsAdmin.getFunctions()
          .taskQueue("updateOrderStatus");

      const retaurantConfirmDeadline =
        new Date(Date.now() + 1000 * 60 * AUTO_CANCEL_ORDER_MINS);
      const collectionEndTime = item.collection.to.toDate();
      const autoCancelTime =
        retaurantConfirmDeadline > collectionEndTime ?
        collectionEndTime :
        retaurantConfirmDeadline;
      functions.logger.log("Scheduling CANCEL_ORDER task for", orderId);
      return queue.enqueue(
          {task: "CANCEL_ORDER", orderId: orderId},
          {scheduleTime: autoCancelTime},
      );
    });


exports.schedulePickupStartAndEnd = functions
    .firestore.document("/orders/{orderId}")
    .onUpdate(async (snap, context) => {
      const orderId = context.params.orderId;
      const newData = snap.after.data();
      const itemRef = admin.firestore().collection("items").doc(newData.itemId);
      functions.logger.log("Getting item for", newData.itemId);
      const item = (await itemRef.get()).data();
      const queue = functionsAdmin.getFunctions()
          .taskQueue("updateOrderStatus");

      const collectionFrom = item.collection.from.toDate();
      const collectionTo = item.collection.to.toDate();

      switch (newData.status) {
        case "OO":
          functions.logger.log("Scheduling AWAIT_PICKUP task for", orderId);
          queue.enqueue(
              {task: "AWAIT_PICKUP", orderId: orderId},
              {scheduleTime: collectionFrom},
          );
          break;
        case "OOO":
          functions.logger.log("Scheduling FAIL_PICKUP task for", orderId);
          queue.enqueue(
              {task: "FAIL_PICKUP", orderId: orderId},
              {scheduleTime: collectionTo},
          );
          break;
      }
      return;
    });

exports.updateOrderStatus = functions
    .tasks.taskQueue()
    .onDispatch(async (data, context) => {
      const {task, orderId} = data;
      const orderRef = admin.firestore().collection("orders").doc(orderId);

      await admin.firestore().runTransaction(async (t) => {
        const currStatus = (await t.get(orderRef)).data().status;

        switch (task) {
          case "CANCEL_ORDER":
            if (currStatus !== "O") {
              functions.logger.log("Invalid status for CANCEL_ORDER task");
            } else {
              t.update(orderRef, {status: "OX"});
              functions.logger.log("Updated status for CANCEL_ORDER task");
            }
            break;
          case "AWAIT_PICKUP":
            if (currStatus !== "OO") {
              functions.logger.log("Invalid status for AWAIT_PICKUP task");
            } else {
              t.update(orderRef, {status: "OOO"});
              functions.logger.log("Updated status for AWAIT_PICKUP task");
            }
            break;
          case "FAIL_PICKUP":
            if (currStatus !== "OOO") {
              functions.logger.log("Invalid status for FAIL_PICKUP task");
            } else {
              t.update(orderRef, {status: "OOX"});
              functions.logger.log("Updated status for FAIL_PICKUP task");
            }
            break;
          default:
            functions.logger.log("Unknown task:", task);
        }
      },
      );
      functions.logger.log("Task Done");
    });


exports.sendOrderNotification = functions
    .firestore.document("/orders/{orderId}")
    .onUpdate(async (snap, context) => {
      const orderId = context.params.orderId;
      const newData = snap.after.data();

      const itemRef = admin.firestore().collection("items").doc(newData.itemId);
      functions.logger.log("Getting item for", newData.itemId);
      const item = (await itemRef.get()).data();

      // eslint-disable-next-line max-len
      const businessRef = admin.firestore().collection("business").doc(newData.businessId);
      functions.logger.log("Getting business for", newData.businessId);
      const business = (await businessRef.get()).data();

      const collectionFrom = item.collection.from.toDate();
      const collectionTo = item.collection.to.toDate();

      const notification = {};
      const apns = {payload: {aps: {contentAvailable: true, sound: "default"}}};
      const token = newData.fcmToken;
      // const data = {};

      switch (newData.status) {
        case "OO":
          functions.logger.log("Sending Order Confirmed Notification", orderId);
          notification.title = "Order Confirmed";
          notification.body =
            // eslint-disable-next-line max-len
            `Your ${item.name} at ${business.name} has been confirmed. Collection starts at ${amPmTimeDescription(collectionFrom)}`;
          // data.type = "ORDER_CONFIRMED";
          break;
        case "OX":
          functions.logger.log("Sending Order Cancelled Notification", orderId);
          notification.title = "Order Cancelled";
          notification.body =
            `Your ${item.name} at ${business.name} has been cancelled`;
          // data.type = "ORDER_CANCELLED";
          break;
        case "OOO":
          functions.logger.log("Sending Await Pickup Notification", orderId);
          notification.title = "Order Ready For Collection";
          notification.body =
            // eslint-disable-next-line max-len
            `Collect your ${item.name} at ${business.name} before ${amPmTimeDescription(collectionTo)}`;
          break;
        default:
          functions.logger.log("Notification for state change not required");
          return;
      }
      // data.collectFrom = collectionFrom;
      // data.collectTo = collectionTo;

      const message = {notification, apns, token};
      const response = await admin.messaging().send(message);
      functions.logger.log("Notification status:", response.results);
      return;
    });

exports.sendOrderPlacedMessage = functions
    .firestore.document("/orders/{orderId}")
    .onCreate(async (snap, context) => {
      const itemRef =
        admin.firestore().collection("items").doc(snap.data().itemId);
      const businessRef =
        admin.firestore().collection("business").doc(snap.data().businessId);
      functions.logger.log("Getting item for", snap.data().itemId);
      const item = (await itemRef.get()).data();
      functions.logger.log("Getting business for", snap.data().businessId);
      const business = (await businessRef.get()).data();

      // eslint-disable-next-line max-len
      const messageBody = `New Order ${context.params.orderId}. Please CONFIRM/CANCEL the order for ${item.name} within ${AUTO_CANCEL_ORDER_MINS} minutes`;

      admin
          .firestore()
          .collection("messages")
          .add({
            to: business.contact.primary,
            body: messageBody,
          })
          .then(() => console.log("Queued message for delivery!"));
    });

const amPmTimeDescription = (dateTime) => {
  // eslint-disable-next-line max-len
  const offsetedDate = new Date(dateTime.toLocaleString("en-us", {timeZone: TIME_ZONE}));
  const amPm = offsetedDate.getHours() < 12 ? "AM" : "PM";

  const hours = pad(
    // eslint-disable-next-line max-len
    offsetedDate.getHours() < 13 ? offsetedDate.getHours() : offsetedDate.getHours() - 12,
    2,
  );

  const mins = pad(offsetedDate.getMinutes(), 2);

  return hours + ":" + mins + amPm;
};

const pad = (num, size) => {
  num = num.toString();
  while (num.length < size) {
    num = "0" + num;
  }
  return num;
};
