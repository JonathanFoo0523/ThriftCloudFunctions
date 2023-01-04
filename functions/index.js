const functions = require("firebase-functions");

const admin = require("firebase-admin");
const functionsAdmin = require("firebase-admin/functions");

admin.initializeApp();

const AUTO_CANCEL_ORDER_MINS = 30;

exports.scheduleCancelOrder = functions
    .firestore.document("/orders/{orderId}")
    .onCreate((snap, context) => {
      const orderId = context.params.orderId;
      const queue = functionsAdmin.getFunctions()
          .taskQueue("updateOrderStatus");
      const scheduleDelaySeconds = 60 * AUTO_CANCEL_ORDER_MINS;
      functions.logger.log("Scheduling CANCEL_ORDER task for", orderId);
      return queue.enqueue(
          {task: "CANCEL_ORDER", orderId: orderId},
          {scheduleDelaySeconds},
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


