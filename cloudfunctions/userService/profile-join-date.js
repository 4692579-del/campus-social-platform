function joinDateFields(user) {
  if (user.officialVerified === true && /^\d{4}-(0[1-9]|1[0-2])$/.test(user.publicJoinedMonth || '')) {
    const [year, month] = user.publicJoinedMonth.split('-');
    return { createdAt: null, joinedMonth: `${year}年${Number(month)}月` };
  }
  return { createdAt: user.createdAt || null };
}

module.exports = { joinDateFields };
