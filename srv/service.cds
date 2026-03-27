using my.sales as db from '../db/schema';

service SalesService {
  entity Customers as projection on db.Customers;
  entity SalesOrders as projection on db.SalesOrders;
}