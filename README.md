# ThriftCloudFunctions

A Firebase Cloud Functions implementation to support [ThriftCustomer](https://github.com/JonathanFoo0523/ThriftCustomer) and ThriftBusiness. See the README files of both directories to learn more other components of the project.

## Order State Diagram
![](https://github.com/JonathanFoo0523/ThriftCloudFunctions/blob/main/OrderDiagram.jpeg)

## Motivation
The database(implemented using Firestore) of the application stores the status of the order which are retrived by ThriftCustomer and ThriftBusiness. We use an entry in every `order` document to denotes its status: `O(ORDER_PLACED)`, `OX(ORDER_CANCELLED)`, `OO(ORDER_CONFIRMED)`, `OOO(ORDER_AWAIT_PICKUP)`, `OOX(ORDER_NOT_PICKED`),`OOOO(ORDER_COMPLETED)`. 

While some of the status can be set proactively - ThriftBusiness is responsible to change order status from `ORDER_PLACED` to `ORDER_CONFIRMED`; and ThriftCustomer is responsible to change order status from `ORDER_AWAIT_PICKUP` to `ORDER_COMPLETED`, some status change must be done by entity beside ThriftCustomer and ThriftBusiness. For instance, we want the status to change from `ORDER_CONFIRMED` to `ORDER_AWAIT_PICKUP` even when both customer app and business app are offline, and change from `ORDER_AWAIT_PICKUP` and `ORDER_NOT_PICKED` automatically after the collection time end. Futhermore, we want an order to be automatically cancelled when a business doesn't confirmed an order within 30 minutes after the order is placed.

## Technology
* Firebase Cloud Function
* Google Cloud Task

## Architecture
To update the order's status in the background, we make use of Firestore Cloud Functions which was triggered whenever an order's status change. The Cloud Functions will then schedule a task to update the status and enqueue it to Google Cloud Task's queue. For instance, whenever an order status is changed to `OO(ORDER_CONFIRMED)`, we schedule a task to update the status of order to `OOO(ORDER_AWAIT_PICKUP)` at the start of the collection time. Similarly, whenever a new `order` documents is created, we scheuled a task to change the order from `O(ORDER_PLACED)` to `OX(ORDER_CANCELLED)` after 30 minutes.

To simplify architecture, we don't explicitly remove a task even when it's not necessary to perform a task: when a business confirmed an order after the task to automatically cancel the order has been scheduled. Instead, the Cloud Functions will perform a transaction on the Firestore's document and only perform the status change to `ORDER_CANCELLED` when the previous status is `ORDER_PLACED`. A Firestore's transaction is necessary to avoid a race condition.
