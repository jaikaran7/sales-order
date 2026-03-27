namespace my.sales;

entity Customers {
  key ID : UUID;
  name : String;
}

entity SalesOrders {
  key ID : UUID;
  product : String;
  price : Decimal(9,2);
  customer : Association to Customers;
}