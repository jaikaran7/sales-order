namespace my.sales;

entity Customers {
  key ID : UUID;
  name : String;
}

entity SalesOrders {
  key ID : UUID;
  product : String;
  price : Decimal(10,2);

  customer_ID : UUID;
  customer : Association to Customers on customer.ID = customer_ID;
}