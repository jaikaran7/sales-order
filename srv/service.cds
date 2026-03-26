using my.sales as db from '../db/schema';

service SalesService {

    entity SalesOrders as projection on db.SalesOrders;
    entity Customers as projection on db.Customers;

}